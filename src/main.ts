import { InstanceBase, runEntrypoint, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { PairingClient, BridgeFinder, BridgeNetInfo, LeapClient, SmartBridge, DeviceDefinition } from 'lutron-leap'
import forge from 'node-forge'

const PAIRING_PORT = 8083
const LEAP_PORT = 8081
const UNKNOWN_BRIDGE_ID = 'unknown-bridge-id'

export class ModuleInstance extends InstanceBase<ModuleConfig, ModuleSecrets> {
	config!: ModuleConfig // Setup in init()
	secrets!: ModuleSecrets
	discoveredBridges: Record<string, string>
	bridge?: SmartBridge
	devicesOnBridge: DeviceDefinition[]
	constructor(internal: unknown) {
		super(internal)
		this.discoveredBridges = {}
		this.devicesOnBridge = []
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

		await this.updateActions() // export actions
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
		if (this.config.host !== prevConfig.host) {
			// host changed, need to re-pair
			this.updateStatus(InstanceStatus.Connecting, 'Pairing with Bridge')
			this.log('info', 'pairing...')
			await this.pairWithBridge()
		}

		this.saveConfig(this.config, this.secrets)
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

		const leapClient = new LeapClient(
			this.config.host,
			LEAP_PORT,
			this.secrets.bridgeCerts.ca,
			this.secrets.bridgeCerts.privateKey,
			this.secrets.bridgeCerts.certificate,
		)

		try {
			await leapClient.connect()
		} catch (err: any) {
			this.updateStatus(InstanceStatus.ConnectionFailure, `Bridge connection failed: ${err.message}`)
			this.log('error', `Bridge connection failed: ${err.message}`)
			return
		}

		this.bridge = new SmartBridge(this.config.bridgeID, leapClient)

		// load devices
		const devices = await this.bridge.getDeviceInfo()
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
		this.updateStatus(InstanceStatus.Ok)
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.discoveredBridges)
	}

	async updateActions(): Promise<void> {
		await UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
