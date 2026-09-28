import type { ModuleInstance } from './main.js'
import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import type { DeviceDefinition, OccupancyGroupStatus, OccupancyGroupDefinition } from 'lutron-leap'
import { getDeviceLabel, slugify } from './deviceTypes.js'

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
					}
				}
			})

			if (deviceSerials.length > 0) {
				self.occupancyGroupToDevices[href] = deviceSerials
			}
		})

		handleOccupancyStatuses(self, body.OccupancyGroupStatuses)

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
				// First observation for this sensor: we don't actually know when it
				// last changed either direction. Seed both to the Unix-epoch sentinel
				// (0 -- the ms equivalent of the conventional 0000-00-00) rather than
				// leaving one undefined, so "time since" math (unixNow() - last_true)
				// always returns a huge-but-valid number for "never observed" instead
				// of needing special-cased undefined handling.
				state.lastTrue = 0
				state.lastFalse = 0
			} else if (wasOccupied !== occupied) {
				if (occupied) state.lastTrue = now
				else state.lastFalse = now
			}

			if (state.variableIdOccupied) values[state.variableIdOccupied] = occupied
			if (state.lastTrue !== undefined && state.variableIdLastTrue) values[state.variableIdLastTrue] = state.lastTrue
			if (state.lastFalse !== undefined && state.variableIdLastFalse)
				values[state.variableIdLastFalse] = state.lastFalse
		})
	})

	self.setVariableValues(values)
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

		variables.push(
			{ variableId: state.variableIdOccupied, name: state.label },
			{ variableId: state.variableIdLastTrue, name: `${state.label} Last Occupied` },
			{ variableId: state.variableIdLastFalse, name: `${state.label} Last Vacant` },
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
	})
	self.setVariableValues(values)
}
