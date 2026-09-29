import type {
	CompanionActionDefinition,
	CompanionVariableDefinition,
	CompanionVariableValues,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import type { DeviceDefinition } from 'lutron-leap'
import { getDeviceLevelType, slugify } from './deviceTypes.js'
import { computeLevelForMode, sendLevel } from './levelControl.js'

// The "Room" a control acts on when nothing more specific is selected. Every
// per-light press updates both its own room's entry *and* this one, so a
// generic multi-room master (e.g. a phone) always has something sensible to
// act on. Two people touching lights in different rooms at once can make the
// house-wide entry jump between them -- a real but narrow race, and only ever
// visible to whatever's using the house-wide entry, not to per-room controls.
const HOUSE_WIDE_ROOM = '__house__'

// Called by any per-light action (the per-device action, Smart Control) when
// it fires -- no configuration needed, since every device already has a
// Lutron-defined Area (self.deviceAreaNames) to key off of.
export function markLightSelected(self: ModuleInstance, device: DeviceDefinition): void {
	const area = self.deviceAreaNames[device.SerialNumber] ?? ''
	self.roomSelectedDeviceSerial[area] = device.SerialNumber
	self.roomSelectedDeviceSerial[HOUSE_WIDE_ROOM] = device.SerialNumber
	updateRoomVariables(self, area)
	updateRoomVariables(self, HOUSE_WIDE_ROOM)
}

function getSelectedDeviceForRoom(self: ModuleInstance, room: string | undefined): DeviceDefinition | undefined {
	const key = room && room !== '' ? room : HOUSE_WIDE_ROOM
	const serial = self.roomSelectedDeviceSerial[key]
	if (!serial) return undefined
	return self.devicesOnBridge.find((d) => d.SerialNumber === serial)
}

// Called whenever a device's live level changes, so a room's (or the
// house-wide) variables stay current without waiting for another press.
export function refreshSelectedLightLevel(self: ModuleInstance, device: DeviceDefinition): void {
	const area = self.deviceAreaNames[device.SerialNumber] ?? ''
	if (self.roomSelectedDeviceSerial[area] === device.SerialNumber) updateRoomVariables(self, area)
	if (self.roomSelectedDeviceSerial[HOUSE_WIDE_ROOM] === device.SerialNumber) updateRoomVariables(self, HOUSE_WIDE_ROOM)
}

function updateRoomVariables(self: ModuleInstance, room: string): void {
	const serial = self.roomSelectedDeviceSerial[room]
	const device = serial ? self.devicesOnBridge.find((d) => d.SerialNumber === serial) : undefined
	const slug = room === HOUSE_WIDE_ROOM ? 'house' : slugify(room)

	const values: CompanionVariableValues = {
		[`room_${slug}_selected_name`]: device ? device.Name : '',
		[`room_${slug}_selected_current`]: device ? (self.currentLevel[device.SerialNumber] ?? 0) : 0,
	}
	self.setVariableValues(values)
}

// Distinct Lutron areas that actually have a controllable (dimmer/switch)
// device -- what the Room dropdown offers, and what gets variables.
function getControllableAreas(self: ModuleInstance): string[] {
	const areas = new Set<string>()
	self.devicesOnBridge.forEach((device) => {
		if (getDeviceLevelType(device) === undefined) return
		const area = self.deviceAreaNames[device.SerialNumber]
		if (area) areas.add(area)
	})
	return Array.from(areas).sort((a, b) => a.localeCompare(b))
}

export function BuildSelectedLightVariableDefinitions(self: ModuleInstance): CompanionVariableDefinition[] {
	const variables: CompanionVariableDefinition[] = [
		{ variableId: 'room_house_selected_name', name: 'Selected Light (Whole House): Name' },
		{ variableId: 'room_house_selected_current', name: 'Selected Light (Whole House): Level' },
	]
	getControllableAreas(self).forEach((area) => {
		const slug = slugify(area)
		variables.push(
			{ variableId: `room_${slug}_selected_name`, name: `Selected Light (${area}): Name` },
			{ variableId: `room_${slug}_selected_current`, name: `Selected Light (${area}): Level` },
		)
	})
	return variables
}

export function SeedSelectedLightVariableValues(self: ModuleInstance): void {
	Object.keys(self.roomSelectedDeviceSerial).forEach((room) => updateRoomVariables(self, room))
}

// Mirrors the per-device level action's on/full/off/value/brighten/dim modes,
// but instead of a Device option, takes a Room -- and acts on whichever light
// was most recently touched in that room (or, for "House", anywhere).
// Duplicate this action across a room's own page with Room set to that room,
// or drop one on a multi-room master (phone, etc) left on "House".
export function BuildSelectedLightAction(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const areas = getControllableAreas(self)
	if (areas.length === 0) return {}

	return {
		surface_selected_light_control: {
			name: 'Selected Light Control (most recently touched light)',
			options: [
				{
					id: 'room',
					type: 'dropdown',
					label: 'Room',
					description: 'House: whatever light was most recently touched anywhere, not just this room.',
					default: HOUSE_WIDE_ROOM,
					choices: [{ id: HOUSE_WIDE_ROOM, label: 'House' }, ...areas.map((area) => ({ id: area, label: area }))],
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Control',
					default: 'on',
					choices: [
						{ id: 'on', label: 'On (Resume Last Level)' },
						{ id: 'full', label: 'Full (100%)' },
						{ id: 'off', label: 'Off' },
						{ id: 'value', label: 'Specific Value / Preset' },
						{ id: 'brighten', label: 'Brighten (+X%)' },
						{ id: 'dim', label: 'Dim (-X%)' },
					],
				},
				{
					id: 'brightness_value',
					type: 'number',
					label: 'Brightness Value',
					range: true,
					default: 50,
					min: 0,
					max: 100,
					isVisible: (opts) => opts.mode === 'value',
				},
				{
					id: 'step_percent',
					type: 'number',
					label: 'Step Amount (%)',
					range: true,
					default: 10,
					min: 1,
					max: 100,
					isVisible: (opts) => opts.mode === 'brighten' || opts.mode === 'dim',
				},
				{
					id: 'fade_time_on',
					type: 'number',
					label: 'Fade Time (seconds)',
					default: 0.75,
					min: 0,
					max: 10,
					step: 0.25,
					range: true,
					isVisible: (opts) => opts.mode !== 'off',
				},
				{
					id: 'fade_time_off',
					type: 'number',
					label: 'Fade Time (seconds)',
					default: 2.5,
					min: 0,
					max: 10,
					step: 0.25,
					range: true,
					isVisible: (opts) => opts.mode === 'off',
				},
			],
			callback: async (event) => {
				const device = getSelectedDeviceForRoom(self, event.options.room as string)
				if (!device) {
					self.log('debug', `Selected Light Control: nothing selected yet for room "${event.options.room}"`)
					return
				}

				const levelType = getDeviceLevelType(device) ?? 'switch'
				const mode = event.options.mode as string
				const level = computeLevelForMode(self, device, levelType, mode, event.options)
				const fadeTimeValue =
					((mode === 'off' ? event.options.fade_time_off : event.options.fade_time_on) as number) || 0

				await sendLevel(self, device, level, fadeTimeValue)
			},
		},
	}
}
