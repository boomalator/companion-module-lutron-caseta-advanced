import type {
	CompanionActionDefinition,
	CompanionOptionValues,
	CompanionVariableDefinition,
	CompanionVariableValues,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import type { DeviceDefinition, FanSpeedType } from 'lutron-leap'
import { getDeviceLevelType, isFanDevice, slugify } from './deviceTypes.js'
import { computeLevelForMode, sendLevel, sendFanSpeed } from './levelControl.js'
import { FAN_SPEED_CHOICES, FAN_SPEED_PERCENT } from './fanTypes.js'
import { startRamp, stopRampsInRoom } from './ramp.js'

// The "Room" a control acts on when nothing more specific is selected. Every
// per-light press updates both its own room's entry *and* this one, so a
// generic multi-room master (e.g. a phone) always has something sensible to
// act on. Two people touching lights in different rooms at once can make the
// house-wide entry jump between them -- a real but narrow race, and only ever
// visible to whatever's using the house-wide entry, not to per-room controls.
const HOUSE_WIDE_ROOM = '__house__'

// Called by any per-device action (the per-device level action, Smart
// Control, the fan speed action) when it fires -- no configuration needed,
// since every device already has a Lutron-defined Area (self.deviceAreaNames)
// to key off of. Despite the name, this tracks fans too, not just lights.
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

	// A fan has no 0-100 Level of its own (self.currentLevel is never set for
	// one) -- report its speed as the equivalent assumed percent instead, same
	// as the fan's own dedicated variable does.
	const current = device
		? isFanDevice(device)
			? FAN_SPEED_PERCENT[self.currentFanSpeed[device.SerialNumber] ?? 'Off']
			: (self.currentLevel[device.SerialNumber] ?? 0)
		: 0

	const values: CompanionVariableValues = {
		[`room_${slug}_selected_name`]: device ? device.Name : '',
		[`room_${slug}_selected_current`]: current,
	}
	self.setVariableValues(values)
}

// Distinct Lutron areas that actually have a controllable (dimmer/switch/fan)
// device -- what the Room dropdown offers, and what gets variables.
function getControllableAreas(self: ModuleInstance): string[] {
	const areas = new Set<string>()
	self.devicesOnBridge.forEach((device) => {
		if (getDeviceLevelType(device) === undefined && !isFanDevice(device)) return
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

// Fans use the same modes as lights (bar the ramps, which a fan can't do), mapped onto
// their 5 discrete speeds instead of a 0-100 level: on resumes Medium if it was off,
// toggle flips between Off and that, full/off go to the top/bottom speed, brighten/dim
// step one speed at a time (the step % option is ignored -- there's no finer
// resolution than one speed), and value/preset snaps to whichever speed is closest to
// the requested %.
function computeFanSpeedForMode(
	self: ModuleInstance,
	device: DeviceDefinition,
	mode: string,
	options: CompanionOptionValues,
): FanSpeedType {
	const current = self.currentFanSpeed[device.SerialNumber] ?? 'Off'
	const currentIndex = Math.max(0, FAN_SPEED_CHOICES.indexOf(current))

	switch (mode) {
		case 'off':
			return 'Off'
		case 'toggle':
			return current === 'Off' ? 'Medium' : 'Off'
		case 'full':
			return 'High'
		case 'value': {
			const target = (options.brightness_value as number) ?? 50
			return FAN_SPEED_CHOICES.reduce((closest, speed) =>
				Math.abs(FAN_SPEED_PERCENT[speed] - target) < Math.abs(FAN_SPEED_PERCENT[closest] - target) ? speed : closest,
			)
		}
		case 'brighten':
			return FAN_SPEED_CHOICES[Math.min(FAN_SPEED_CHOICES.length - 1, currentIndex + 1)]
		case 'dim':
			return FAN_SPEED_CHOICES[Math.max(0, currentIndex - 1)]
		case 'on':
		default:
			return current === 'Off' ? 'Medium' : current
	}
}

// Mirrors the per-device level action's modes, but instead of a Device option, takes a
// Room -- and acts on whichever light was most recently touched in that room (or, for
// "House", anywhere). Duplicate this action across a room's own page with Room set to
// that room, or drop one on a multi-room master (phone, etc) left on "House".
//
// Besides the one-shot modes it can start and stop a ramp on that light, which is a
// more natural way to dim a selected light than repeated steps: put Start Ramp Up/Down
// in a "Held for" duration group and Stop Ramp in the matching "Release after" group
// (see smartControl.ts). Ramps need a dimmer: on a switch or fan they do nothing.
const RAMP_MODES = ['ramp_up', 'ramp_down']

export function BuildSelectedLightAction(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const areas = getControllableAreas(self)
	if (areas.length === 0) return {}

	return {
		surface_selected_light_control: {
			name: 'Selected Light Control',
			options: [
				{
					id: 'room',
					type: 'dropdown',
					label: 'Room',
					description:
						'Acts on the most recently touched light in this room. House: whatever light was most recently touched anywhere, not just this room.',
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
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'value', label: 'Specific Value / Preset' },
						{ id: 'brighten', label: 'Brighten (+X%)' },
						{ id: 'dim', label: 'Dim (-X%)' },
						{ id: 'ramp_up', label: 'Start Ramp Up' },
						{ id: 'ramp_down', label: 'Start Ramp Down' },
						{ id: 'ramp_stop', label: 'Stop Ramp' },
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
					id: 'ramp_rate_percent_per_sec',
					type: 'number',
					label: 'Ramp Rate (%/sec)',
					default: 30,
					min: 1,
					max: 100,
					isVisible: (opts) => RAMP_MODES.includes(opts.mode as string),
				},
				{
					id: 'ramp_tick_ms',
					type: 'number',
					label: 'Ramp Update Interval (ms)',
					description:
						'How often the ramp steps. A Lutron zone handles about 6 commands/sec (~160ms each), so faster than that gains nothing. Slower gives bigger, less frequent steps at the same Ramp Rate.',
					default: 200,
					min: 50,
					max: 1000,
					isVisible: (opts) => RAMP_MODES.includes(opts.mode as string),
				},
				{
					id: 'ramp_floor_percent',
					type: 'number',
					label: 'Ramp Floor (%)',
					description:
						'Start Ramp Down stops here instead of going all the way to 0. Default 0 -- ramps all the way off.',
					range: true,
					default: 0,
					min: 0,
					max: 99,
					isVisible: (opts) => opts.mode === 'ramp_down',
				},
				// Toggle shows both fades, since which one applies depends on the light's state.
				{
					id: 'fade_time_on',
					type: 'number',
					label: 'Fade Time, Turning On (seconds)',
					default: 0.75,
					min: 0,
					max: 10,
					step: 0.25,
					range: true,
					isVisible: (opts) => opts.mode !== 'off' && !String(opts.mode).startsWith('ramp_'),
				},
				{
					id: 'fade_time_off',
					type: 'number',
					label: 'Fade Time, Turning Off (seconds)',
					default: 2.5,
					min: 0,
					max: 10,
					step: 0.25,
					range: true,
					isVisible: (opts) => opts.mode === 'off' || opts.mode === 'toggle',
				},
			],
			callback: async (event) => {
				const room = event.options.room as string
				const mode = event.options.mode as string

				// Stop first, before the "nothing selected" check: the light that was selected when
				// the ramp started may not be the selected one now, and a ramp must never be left
				// running. Stops every ramp in the room (every ramp at all for "House").
				if (mode === 'ramp_stop') {
					stopRampsInRoom(self, room === HOUSE_WIDE_ROOM ? undefined : room)
					return
				}

				const device = getSelectedDeviceForRoom(self, room)
				if (!device) {
					self.log('debug', `Selected Light Control: nothing selected yet for room "${room}"`)
					return
				}

				if (RAMP_MODES.includes(mode)) {
					if (getDeviceLevelType(device) !== 'dimmer') {
						self.log('debug', `Selected Light Control: ${device.Name} is not a dimmer, so it can't ramp`)
						return
					}
					startRamp(self, device, mode === 'ramp_up' ? 'up' : 'down', event.options)
					return
				}

				if (isFanDevice(device)) {
					const speed = computeFanSpeedForMode(self, device, mode, event.options)
					await sendFanSpeed(self, device, speed)
					return
				}

				const levelType = getDeviceLevelType(device) ?? 'switch'
				const level = computeLevelForMode(self, device, levelType, mode, event.options)
				// Toggle fades by where it ends up: a fade down when it turns the light off.
				const fadingOff = mode === 'off' || (mode === 'toggle' && level === 0)
				const fadeTimeValue = ((fadingOff ? event.options.fade_time_off : event.options.fade_time_on) as number) || 0

				await sendLevel(self, device, level, fadeTimeValue)
			},
		},
	}
}
