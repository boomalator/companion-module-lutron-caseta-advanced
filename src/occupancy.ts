import type { ModuleInstance } from './main.js'
import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import type { DeviceDefinition, OccupancyGroupStatus, OccupancyGroupDefinition } from 'lutron-leap'
import { getDeviceLabel, slugify } from './deviceTypes.js'
import type { ModuleConfig } from './config.js'

const OCCUPANCY_SENSOR_DEVICE_TYPE = 'RPSOccupancySensor'

// The library's BodyType union is missing this shape -- confirmed live that
// ReadRequest on a group href actually returns { OccupancyGroup: {...} } nested,
// same mismatch pattern as a few other gaps found in this library tonight.
interface OneOccupancyGroupDefinitionBody {
	OccupancyGroup: OccupancyGroupDefinition
}

export interface OccupancySensorState {
	deviceSerial: string
	label: string
	occupied?: boolean
	// Unix ms, matching Companion's own unixNow() expression function -- lets you
	// write unixNow() - $(...:sensor_last_true) directly with no parsing/conversion.
	// Use Companion's msToTimestamp() in an expression if you want it displayed
	// as a readable string.
	lastTrue?: number
	lastFalse?: number
	variableIdOccupied: string
	variableIdLastTrue: string
	variableIdLastFalse: string
	// What the bridge reports about the sensor itself (read from /device/N/status, which it
	// won't push, so it is refreshed on the health-check cycle): Available / Unavailable /
	// Unknown, and the battery's LevelState (Good, Low, ...).
	deviceHref: string
	availability?: string
	battery?: string
	variableIdAvailability: string
	variableIdBattery: string
}

interface DeviceStatusBody {
	DeviceStatus?: { Availability?: string; BatteryStatus?: { LevelState?: string } }
}

// Confirmed against a live bridge: LEAP reports occupancy per "occupancy group",
// not per physical sensor -- a group can merge multiple sensors covering one area
// (e.g. top and bottom of a stairwell) into a single status. So this maps each
// group to every device sharing it, and a status update fans out to all of them
// identically -- that's the most LEAP gives us; there's no way to tell which
// specific sensor in a merged group triggered it.
export async function SubscribeToOccupancy(self: ModuleInstance): Promise<void> {
	const bridge = self.bridge
	if (!bridge) return

	self.occupancySensors = {}
	self.occupancyGroupToDevices = {}

	const sensorDevices = self.devicesOnBridge.filter(
		(d) => d.DeviceType === OCCUPANCY_SENSOR_DEVICE_TYPE && d.OccupancySensors?.[0],
	)
	if (sensorDevices.length === 0) return

	const sensorHrefToDevice = new Map<string, DeviceDefinition>()
	sensorDevices.forEach((d) => sensorHrefToDevice.set(d.OccupancySensors[0].href, d))

	try {
		const statusResp = await bridge.client.request('ReadRequest', '/occupancygroup/status')
		const body = statusResp.Body
		if (!body || !('OccupancyGroupStatuses' in body)) return

		const groupDefs = await Promise.all(
			body.OccupancyGroupStatuses.map(async (s) => {
				try {
					const d = await bridge.client.request('ReadRequest', s.OccupancyGroup.href)
					return { href: s.OccupancyGroup.href, body: d.Body }
				} catch (err) {
					self.log('warn', `Failed to read occupancy group ${s.OccupancyGroup.href}: ${(err as Error).message}`)
					return { href: s.OccupancyGroup.href, body: undefined }
				}
			}),
		)

		groupDefs.forEach(({ href, body: groupBody }) => {
			if (!groupBody || !('OccupancyGroup' in groupBody)) return
			const groupDef = (groupBody as unknown as OneOccupancyGroupDefinitionBody).OccupancyGroup

			const deviceSerials: string[] = []
			;(groupDef.AssociatedSensors ?? []).forEach((assoc) => {
				const device = sensorHrefToDevice.get(assoc.OccupancySensor.href)
				if (!device) return

				deviceSerials.push(device.SerialNumber)
				if (!self.occupancySensors[device.SerialNumber]) {
					self.occupancySensors[device.SerialNumber] = {
						deviceSerial: device.SerialNumber,
						label: getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device),
						variableIdOccupied: '',
						variableIdLastTrue: '',
						variableIdLastFalse: '',
						deviceHref: device.href,
						variableIdAvailability: '',
						variableIdBattery: '',
					}
				}
			})

			if (deviceSerials.length > 0) {
				self.occupancyGroupToDevices[href] = deviceSerials
			}
		})

		handleOccupancyStatuses(self, body.OccupancyGroupStatuses)
		await RefreshSensorStatus(self)

		await bridge.client.subscribe('/occupancygroup/status', (resp) => {
			const b = resp.Body
			if (b && 'OccupancyGroupStatuses' in b) {
				handleOccupancyStatuses(self, b.OccupancyGroupStatuses)
			}
		})
	} catch (err) {
		self.log('error', `Failed to set up occupancy tracking: ${(err as Error).message}`)
	}
}

function handleOccupancyStatuses(self: ModuleInstance, statuses: OccupancyGroupStatus[]): void {
	const values: CompanionVariableValues = {}
	const now = Date.now()
	let changed = false

	statuses.forEach((status) => {
		const deviceSerials = self.occupancyGroupToDevices[status.OccupancyGroup.href]
		if (!deviceSerials) return

		const occupied = status.OccupancyStatus === 'Occupied'

		deviceSerials.forEach((serial) => {
			const state = self.occupancySensors[serial]
			if (!state) return

			const wasOccupied = state.occupied
			state.occupied = occupied

			if (wasOccupied === undefined) {
				// First observation since the module started. The bridge never says when a
				// sensor last changed, so what we know comes from what was saved the last
				// time we watched it (see persistChangeTimes). With nothing saved we don't
				// know when it changed either way, so both are the Unix-epoch sentinel (0)
				// rather than undefined, so "time since" math (unixNow() - last_true) is
				// always a valid number for "never observed".
				const saved = self.config.occupancyChanges?.[serial]
				state.lastTrue = saved?.lastTrue ?? 0
				state.lastFalse = saved?.lastFalse ?? 0
				// It changed while the module wasn't watching: the best time we have is now.
				if (saved && saved.occupied !== occupied) {
					if (occupied) state.lastTrue = now
					else state.lastFalse = now
				}
				changed = true
			} else if (wasOccupied !== occupied) {
				if (occupied) state.lastTrue = now
				else state.lastFalse = now
				changed = true
			}

			if (state.variableIdOccupied) values[state.variableIdOccupied] = occupied
			if (state.lastTrue !== undefined && state.variableIdLastTrue) values[state.variableIdLastTrue] = state.lastTrue
			if (state.lastFalse !== undefined && state.variableIdLastFalse)
				values[state.variableIdLastFalse] = state.lastFalse
		})
	})

	self.setVariableValues(values)
	if (changed) persistChangeTimes(self)
}

// Saves each sensor's state and change times in the module's config, so "time in this
// state" survives a restart instead of starting again from "unknown". Written only when
// something differs from what is already saved.
function persistChangeTimes(self: ModuleInstance): void {
	const current: NonNullable<ModuleConfig['occupancyChanges']> = {}
	for (const state of Object.values(self.occupancySensors)) {
		if (state.occupied === undefined) continue
		current[state.deviceSerial] = {
			occupied: state.occupied,
			lastTrue: state.lastTrue ?? 0,
			lastFalse: state.lastFalse ?? 0,
		}
	}
	if (JSON.stringify(current) === JSON.stringify(self.config.occupancyChanges)) return

	self.config.occupancyChanges = current
	self.saveConfig(self.config, self.secrets)
}

// Reads each sensor's own status: whether the bridge can reach it and its battery level.
// Called when sensors are set up and on every health-check cycle; the bridge doesn't push
// these, and they change slowly.
export async function RefreshSensorStatus(self: ModuleInstance): Promise<void> {
	const bridge = self.bridge
	if (!bridge) return

	const values: CompanionVariableValues = {}
	await Promise.all(
		Object.values(self.occupancySensors).map(async (state) => {
			try {
				const body = (await bridge.client.request('ReadRequest', `${state.deviceHref}/status`))
					.Body as unknown as DeviceStatusBody
				const status = body?.DeviceStatus
				if (!status) return

				const availability = status.Availability ?? 'Unknown'
				const battery = status.BatteryStatus?.LevelState ?? 'Unknown'
				if (availability !== state.availability) {
					state.availability = availability
					if (state.variableIdAvailability) values[state.variableIdAvailability] = availability
				}
				if (battery !== state.battery) {
					state.battery = battery
					if (state.variableIdBattery) values[state.variableIdBattery] = battery
				}
			} catch (err) {
				self.log('debug', `Could not read the status of ${state.label}: ${(err as Error).message}`)
			}
		}),
	)
	if (Object.keys(values).length > 0) self.setVariableValues(values)
}

export function BuildOccupancyVariableDefinitions(self: ModuleInstance): CompanionVariableDefinition[] {
	const entries = Object.values(self.occupancySensors).sort((a, b) => a.label.localeCompare(b.label))

	const variables: CompanionVariableDefinition[] = []
	const usedIds = new Set<string>()

	entries.forEach((state) => {
		let base = slugify(state.label)
		if (usedIds.has(`${base}_occupied`)) {
			base = `${slugify(state.label)}_${state.deviceSerial}`
		}
		usedIds.add(`${base}_occupied`)

		state.variableIdOccupied = `${base}_occupied`
		state.variableIdLastTrue = `${base}_last_true`
		state.variableIdLastFalse = `${base}_last_false`
		state.variableIdAvailability = `${base}_availability`
		state.variableIdBattery = `${base}_battery`

		variables.push(
			{ variableId: state.variableIdOccupied, name: state.label },
			{ variableId: state.variableIdLastTrue, name: `${state.label} Last Occupied` },
			{ variableId: state.variableIdLastFalse, name: `${state.label} Last Vacant` },
			{ variableId: state.variableIdAvailability, name: `${state.label} Availability` },
			{ variableId: state.variableIdBattery, name: `${state.label} Battery` },
		)
	})

	return variables
}

export function SeedOccupancyVariableValues(self: ModuleInstance): void {
	const values: CompanionVariableValues = {}
	Object.values(self.occupancySensors).forEach((state) => {
		if (state.occupied !== undefined && state.variableIdOccupied) values[state.variableIdOccupied] = state.occupied
		if (state.lastTrue !== undefined && state.variableIdLastTrue) values[state.variableIdLastTrue] = state.lastTrue
		if (state.lastFalse !== undefined && state.variableIdLastFalse) values[state.variableIdLastFalse] = state.lastFalse
		if (state.availability !== undefined && state.variableIdAvailability)
			values[state.variableIdAvailability] = state.availability
		if (state.battery !== undefined && state.variableIdBattery) values[state.variableIdBattery] = state.battery
	})
	self.setVariableValues(values)
}
