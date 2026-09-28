import {
	InstanceBase,
	runEntrypoint,
	InstanceStatus,
	SomeCompanionConfigField,
	type CompanionVariableValues,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { BuildDeviceVariableDefinitions, SeedDeviceVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import {
	PairingClient,
	BridgeFinder,
	BridgeNetInfo,
	LeapClient,
	SmartBridge,
	DeviceDefinition,
	OneAreaDefinition,
	BodyType,
	FanSpeedType,
	VirtualButtonDefinition,
} from 'lutron-leap'
import forge from 'node-forge'
import { getDeviceLevelType, isPicoDevice, isFanDevice, getDeviceLabel } from './deviceTypes.js'
import {
	SubscribeToPicoButtons,
	BuildPicoVariableDefinitions,
	SeedPicoVariableValues,
	type PicoButtonState,
} from './picoButtons.js'
import { BuildFanVariableDefinitions, SeedFanVariableValues, FAN_SPEED_PERCENT } from './fans.js'
import { RefreshScenes } from './scenes.js'
import {
	SubscribeToOccupancy,
	BuildOccupancyVariableDefinitions,
	SeedOccupancyVariableValues,
	type OccupancySensorState,
} from './occupancy.js'

const PAIRING_PORT = 8083
const LEAP_PORT = 8081
const UNKNOWN_BRIDGE_ID = 'unknown-bridge-id'
const HEALTH_CHECK_INTERVAL_MS = 120000 // 2 minutes
const HEALTH_CHECK_TIMEOUT_MS = 8000

export class ModuleInstance extends InstanceBase<ModuleConfig, ModuleSecrets> {
	config!: ModuleConfig // Setup in init()
	secrets!: ModuleSecrets
	discoveredBridges: Record<string, string>
	bridge?: SmartBridge
	devicesOnBridge: DeviceDefinition[]
	deviceAreaNames: Record<string, string>
	deviceVariableIds: Record<string, string>
	currentLevel: Record<string, number>
	lastNonZeroLevel: Record<string, number>
	discoveredPicoDevices: Record<string, string>
	picoButtons: Record<string, PicoButtonState>
	currentFanSpeed: Record<string, FanSpeedType>
	fanVariableIds: Record<string, string>
	fanPercentVariableIds: Record<string, string>
	scenes: Record<string, VirtualButtonDefinition>
	occupancySensors: Record<string, OccupancySensorState>
	occupancyGroupToDevices: Record<string, string[]>
	isReconnecting: boolean
	isDestroyed: boolean
	healthCheckTimer?: ReturnType<typeof setInterval>
	constructor(internal: unknown) {
		super(internal)
		this.discoveredBridges = {}
		this.devicesOnBridge = []
		this.deviceAreaNames = {}
		this.deviceVariableIds = {}
		this.currentLevel = {}
		this.lastNonZeroLevel = {}
		this.discoveredPicoDevices = {}
		this.picoButtons = {}
		this.scenes = {}
		this.currentFanSpeed = {}
		this.fanVariableIds = {}
		this.fanPercentVariableIds = {}
		this.occupancySensors = {}
		this.occupancyGroupToDevices = {}
		this.isReconnecting = false
		this.isDestroyed = false
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets

		// discover bridges (used for dropdown in config)
		this.log('debug', 'Starting bridge discovery')
		this.updateStatus(InstanceStatus.Connecting, 'Initializing')
		await this.startDiscovery()

		// if we have certs, connect to bridge
		if (this.secrets.bridgeCerts) {
			await this.connectToBridge()
		}

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
	}

	async startDiscovery(): Promise<void> {
		const bridgeFinder = new BridgeFinder()
		bridgeFinder.on('discovered', (bridgeInfo: BridgeNetInfo) => {
			this.discoveredBridges[bridgeInfo.ipAddr] = bridgeInfo.bridgeid
			this.log('info', `Discovered Bridge ${bridgeInfo.bridgeid} at ${bridgeInfo.ipAddr}: ${bridgeInfo.systype}`)
		})
		bridgeFinder.beginSearching()
	}

	async pairWithBridge(): Promise<void> {
		const client = new PairingClient(this.config.host, PAIRING_PORT)
		try {
			this.log('debug', 'Pairing client connecting')
			await client.connect()
		} catch (e: any) {
			this.updateStatus(InstanceStatus.ConnectionFailure, `Failed to initialize pairing: ${e.message}`)
			this.log('error', `Failed to initialize pairing: ${e.message}`)
			return
		}

		// wait for pairing button to be pressed on bridge
		this.log('info', 'Waiting for button press on bridge...')
		try {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('timed out')), 30000) // Pairing window is 30 seconds, but companion has a 5s timeout
				client.once('message', (response) => {
					this.log('debug', `got message ${JSON.stringify(response)}`)
					const res = response as { Body: { Status: { Permissions: string[] } } }
					if (res.Body.Status.Permissions.includes('PhysicalAccess')) {
						this.log('debug', 'Physical access confirmed')
						clearTimeout(t)
						resolve()
					} else {
						this.log('debug', `unexpected pairing result ${JSON.stringify(response)}`)
					}
				})
			})
		} catch (e: any) {
			this.log('error', `waiting for button push failed. ${e}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `Pairing timed out: ${e.message}`)
			return
		}

		// generate  keys
		this.log('debug', 'Generating keys for CSR')
		const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
			forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err, keyPair) => {
				if (err !== null) {
					this.log('error', `key generation error: ${err.message}`)
					reject(err)
				} else {
					resolve(keyPair)
				}
			})
		})

		// generate csr and sign with private key
		const csr = forge.pki.createCertificationRequest()
		csr.publicKey = keys.publicKey
		csr.setSubject([
			{
				name: 'commonName',
				value: 'companion-module-lutron-caseta-advanced',
			},
		])
		csr.sign(keys.privateKey)
		const csrText = forge.pki.certificationRequestToPem(csr)

		// pair with bridge using csr
		this.log('debug', 'Sending CSR to bridge for signing')
		let certResult
		try {
			certResult = await new Promise<any>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('CSR response timed out')), 5000)
				client.once('message', (response) => {
					clearTimeout(t)
					resolve(response)
				})

				void client.requestPair(csrText)
			})

			if (certResult.Header.StatusCode !== '200 OK') {
				throw new Error(`bad CSR response: ${JSON.stringify(certResult)}`)
			}
		} catch (e: any) {
			this.log('error', `CSR failed: ${e.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `CSR failed: ${e.message}`)
			return
		}

		// store cert/keys
		if (this.config.host in this.discoveredBridges) {
			this.config.bridgeID = this.discoveredBridges[this.config.host]
		} else {
			this.config.bridgeID = UNKNOWN_BRIDGE_ID // id needs to be resolved later
		}

		this.log('debug', `using bridge id: ${this.config.bridgeID}`)

		this.log('debug', 'Storing bridge certificates')
		this.secrets.bridgeCerts = {
			ca: certResult.Body.SigningResult.RootCertificate,
			certificate: certResult.Body.SigningResult.Certificate,
			privateKey: forge.pki.privateKeyToPem(keys.privateKey),
		}
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		// Set before close() -- closing the socket fires the bridge's own
		// 'disconnected' event, which would otherwise kick off a reconnect attempt
		// on a module that's being torn down.
		this.isDestroyed = true
		this.stopHealthCheck()
		this.bridge?.close()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		// this.log('debug', 'configUpdated')
		const prevConfig = this.config
		// this.log('debug', `Previous config: ${JSON.stringify(prevConfig)}`)
		this.config = config
		this.secrets = secrets
		// this.log('debug', `New config: ${JSON.stringify(this.config)}`)
		this.log('debug', this.config.host !== prevConfig.host ? 'host changed' : 'host unchanged')
		const hostChanged = this.config.host !== prevConfig.host
		if (hostChanged) {
			// host changed, need to re-pair
			this.updateStatus(InstanceStatus.Connecting, 'Pairing with Bridge')
			this.log('info', 'pairing...')
			await this.pairWithBridge()
		}

		this.saveConfig(this.config, this.secrets)

		// Changing which Picos to monitor doesn't need a full bridge teardown and
		// device rediscovery -- that was slow enough (with ~60 devices) to trip
		// Companion's config-save timeout. Just re-subscribe to buttons instead.
		const onlyPicoSelectionChanged =
			!hostChanged &&
			this.bridge !== undefined &&
			prevConfig.bridgeID === this.config.bridgeID &&
			JSON.stringify(prevConfig.picoDeviceIds ?? []) !== JSON.stringify(this.config.picoDeviceIds ?? [])
		if (onlyPicoSelectionChanged) {
			this.log('debug', 'Pico selection changed, re-subscribing without a full reconnect')
			await SubscribeToPicoButtons(this)
			this.updateVariableDefinitions()
			return
		}

		this.log('debug', 're-initializing module')
		await this.init(this.config, false, this.secrets)
	}

	async connectToBridge(): Promise<void> {
		if (!this.config.bridgeID || !this.secrets.bridgeCerts) {
			this.log('warn', 'No bridge ID or certificates found in config/secrets')
			this.updateStatus(InstanceStatus.BadConfig, 'No valid configuration or pairing found')
			return
		}

		this.log('debug', 'Connecting to bridge with id: ' + this.config.bridgeID)
		this.updateStatus(InstanceStatus.Connecting, 'Connecting to Bridge')

		const leapClient = this.createLeapClient()

		try {
			await leapClient.connect()
		} catch (err: any) {
			this.updateStatus(InstanceStatus.ConnectionFailure, `Bridge connection failed: ${err.message}`)
			this.log('error', `Bridge connection failed: ${err.message}`)
			return
		}

		this.bridge = new SmartBridge(this.config.bridgeID, leapClient)
		// Fires on a real dropped connection, and again (by the library's own
		// design) after a successful reconfigureBridge() call -- handleBridgeDisconnected
		// guards against treating that second case as a fresh disconnect.
		this.bridge.on('disconnected', () => {
			if (this.isDestroyed) return
			void this.handleBridgeDisconnected()
		})

		await this.rescanDevices()

		this.updateStatus(InstanceStatus.Ok)
		this.startHealthCheck()

		// Scenes and occupancy involve dozens of extra round trips (12 scenes +
		// 25 occupancy groups on this bridge) -- awaiting them before reporting Ok
		// pushed init() past Companion's own IPC timeout, causing a "Restart forced"
		// crash loop even though the connection itself was fine. Backgrounding them
		// means the connection comes up fast; these two lists populate a moment later.
		void this.refreshSlowExtras()
	}

	async refreshSlowExtras(): Promise<void> {
		await RefreshScenes(this)
		await SubscribeToOccupancy(this)
		this.updateActions()
		this.updateVariableDefinitions()
	}

	createLeapClient(): LeapClient {
		return new LeapClient(
			this.config.host,
			LEAP_PORT,
			this.secrets.bridgeCerts!.ca,
			this.secrets.bridgeCerts!.privateKey,
			this.secrets.bridgeCerts!.certificate,
		)
	}

	// Re-fetches the device list and re-subscribes to everything. Used for the
	// initial connect, after a reconnect, and by the "Rescan Devices" action (e.g.
	// after adding a new Pico in the Lutron app -- the device list is only ever
	// read once per connection, not polled).
	async rescanDevices(): Promise<void> {
		const bridge = this.bridge
		if (!bridge) return

		this.devicesOnBridge = []

		const devices = await bridge.getDeviceInfo()
		devices.forEach((device) => {
			if (device instanceof Error) {
				this.log('error', `Error retrieving device: ${device.message}`)
				return
			} else if (this.config.bridgeID === UNKNOWN_BRIDGE_ID && device.DeviceType === 'SmartBridge') {
				// We found our bridge device, update config
				this.config.bridgeID = device.SerialNumber
				this.saveConfig(this.config, this.secrets)
			} else {
				if (device.AssociatedArea) {
					this.log('info', `${device.DeviceType} device found ${device.Name}.`)
					this.devicesOnBridge.push(device)
				}
			}
		})

		this.log('debug', 'Loaded')

		await this.subscribeToDeviceStatuses()
		await SubscribeToPicoButtons(this)

		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
	}

	// Handles both a genuine dropped connection and the "zombie connection" case
	// (socket still open but not actually working) caught by the health check.
	async handleBridgeDisconnected(): Promise<void> {
		if (this.isReconnecting || this.isDestroyed) return
		if (!this.bridge || !this.secrets.bridgeCerts) return

		this.isReconnecting = true
		this.stopHealthCheck()
		this.log('warn', 'Bridge connection lost, attempting to reconnect')
		this.updateStatus(InstanceStatus.Connecting, 'Reconnecting to bridge')

		try {
			await this.bridge.reconfigureBridge(this.createLeapClient())
			this.log('info', 'Reconnected to bridge, re-subscribing')
			await this.rescanDevices()
			this.updateStatus(InstanceStatus.Ok)
			this.startHealthCheck()
			void this.refreshSlowExtras()
		} catch (err) {
			this.log('error', `Failed to reconnect to bridge: ${(err as Error).message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Reconnect failed')
		} finally {
			this.isReconnecting = false
		}
	}

	startHealthCheck(): void {
		this.stopHealthCheck()
		this.healthCheckTimer = setInterval(() => {
			void this.checkBridgeHealth()
		}, HEALTH_CHECK_INTERVAL_MS)
	}

	stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer)
			this.healthCheckTimer = undefined
		}
	}

	// Backstop for a connection that looks open but has actually gone stale (common
	// over flaky WiFi/NAT) -- the bridge's own disconnect event only fires on a
	// clean TCP close, which a zombie connection won't produce on its own.
	async checkBridgeHealth(): Promise<void> {
		if (!this.bridge || this.isReconnecting || this.isDestroyed) return

		try {
			await Promise.race([
				this.bridge.ping(),
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), HEALTH_CHECK_TIMEOUT_MS)),
			])
		} catch (err) {
			this.log('warn', `Bridge health check failed: ${(err as Error).message}`)
			void this.handleBridgeDisconnected()
		}
	}

	// Fetch each dimmer/switch/Pico's area name (for labeling) and current level, then
	// subscribe to live status pushes so brightness stays accurate as it changes
	// from any source (physical paddle, Lutron app, other integrations, etc). Also
	// records discovered Pico remotes so config can offer them for selection.
	async subscribeToDeviceStatuses(): Promise<void> {
		const bridge = this.bridge
		if (!bridge) return

		const relevantDevices = this.devicesOnBridge.filter(
			(device) => getDeviceLevelType(device) !== undefined || isPicoDevice(device) || isFanDevice(device),
		)

		await Promise.all(
			relevantDevices.map(async (device) => {
				try {
					const areaResponse = await bridge.getHref(device.AssociatedArea)
					this.deviceAreaNames[device.SerialNumber] = (areaResponse as OneAreaDefinition).Area.Name
				} catch (err) {
					this.log('error', `Error getting area for device ${device.Name}: ${(err as Error).message}`)
				}

				if (isPicoDevice(device)) {
					this.discoveredPicoDevices[device.SerialNumber] = getDeviceLabel(
						this.deviceAreaNames[device.SerialNumber] ?? '',
						device,
					)
					return // Picos have no zone/level status to read
				}

				const zone = device.LocalZones[0]
				if (!zone) return
				const statusHref = `${zone.href}/status`

				try {
					const initial = await bridge.client.request('ReadRequest', statusHref)
					if (isFanDevice(device)) {
						this.handleFanStatus(device, initial.Body)
					} else {
						this.handleZoneStatus(device, initial.Body)
					}
				} catch (err) {
					this.log('warn', `Failed to read status for ${device.Name}: ${(err as Error).message}`)
				}

				try {
					await bridge.client.subscribe(statusHref, (resp) => {
						if (isFanDevice(device)) {
							this.handleFanStatus(device, resp.Body)
						} else {
							this.handleZoneStatus(device, resp.Body)
						}
					})
				} catch (err) {
					this.log('warn', `Failed to subscribe to status for ${device.Name}: ${(err as Error).message}`)
				}
			}),
		)
	}

	handleZoneStatus(device: DeviceDefinition, body: BodyType | undefined): void {
		if (!body || !('ZoneStatus' in body)) return

		const level = body.ZoneStatus.Level
		this.currentLevel[device.SerialNumber] = level
		if (level > 0) {
			this.lastNonZeroLevel[device.SerialNumber] = level
		}

		// Variable IDs aren't assigned until updateVariableDefinitions() runs later in
		// init(); status received before then is still recorded above and gets seeded
		// once definitions are built.
		const variableId = this.deviceVariableIds[device.SerialNumber]
		if (variableId) {
			this.setVariableValues({ [variableId]: level })
		}
	}

	handleFanStatus(device: DeviceDefinition, body: BodyType | undefined): void {
		if (!body || !('ZoneStatus' in body)) return

		const speed = body.ZoneStatus.FanSpeed
		this.currentFanSpeed[device.SerialNumber] = speed

		const values: CompanionVariableValues = {}
		const variableId = this.fanVariableIds[device.SerialNumber]
		if (variableId) values[variableId] = speed

		const percentVariableId = this.fanPercentVariableIds[device.SerialNumber]
		if (percentVariableId) values[percentVariableId] = FAN_SPEED_PERCENT[speed]

		this.setVariableValues(values)
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.discoveredBridges, this.discoveredPicoDevices)
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		const deviceVariables = BuildDeviceVariableDefinitions(this)
		const picoVariables = BuildPicoVariableDefinitions(this)
		const fanVariables = BuildFanVariableDefinitions(this)
		const occupancyVariables = BuildOccupancyVariableDefinitions(this)
		this.setVariableDefinitions([...deviceVariables, ...picoVariables, ...fanVariables, ...occupancyVariables])
		SeedDeviceVariableValues(this)
		SeedPicoVariableValues(this)
		SeedFanVariableValues(this)
		SeedOccupancyVariableValues(this)
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
