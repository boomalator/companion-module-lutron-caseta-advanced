import type { CompanionActionDefinition, CompanionOptionValues } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import type { DeviceDefinition } from 'lutron-leap'
import { getDeviceLevelType, getDeviceLabel } from './deviceTypes.js'
import { sendLevel, DEFAULT_UNKNOWN_BRIGHTNESS } from './levelControl.js'
import { markLightSelected } from './selectedLight.js'

// Only a running ramp is stateful. Everything else about a button gesture is
// timed by Companion itself (see below), so the module keeps no press timers.
export interface SmartControlState {
	rampInterval?: ReturnType<typeof setInterval>
	rampDirection?: 'up' | 'down'
	rampLevel?: number
}

// Unconditional, atomic actions -- not named "if off do X, if on do Y" combos,
// which grow combinatorially. Smart Step picks one for when the light is off
// and one for when it's on.
const STEP_ACTION_CHOICES = [
	{ id: 'off', label: 'Off' },
	{ id: 'on', label: 'On (Last)' },
	{ id: 'full', label: 'On (Full)' },
	{ id: 'specific', label: 'On (Specific %)' },
	{ id: 'nudge_up', label: 'Nudge Up (+Step%)' },
	{ id: 'nudge_down', label: 'Nudge Down (-Step%)' },
	{ id: 'none', label: 'Do Nothing' },
]

const RAMP_MODE_CHOICES = [
	{ id: 'up', label: 'Ramp Up' },
	{ id: 'down', label: 'Ramp Down' },
	{ id: 'stop', label: 'Stop Ramp' },
]

// Gesture timing lives in Companion, not here. Companion's duration groups split
// a button's release by how long it was held, and come in pairs per threshold:
//   - "Held for N ms" (execute while held): fires once, at N, while still held
//   - "Release after N+1 ms": always fires on release, for holds past N+1
// plus "Short release", which fires only for releases before the first group.
// Since the button owns the thresholds it can also drive its own feedback (set a
// local variable in a "Held for" group, reset it in the "Release after" group)
// -- which a module-side timer could never show.
//
// This module supplies what the groups do, as two actions:
//   - Smart Step: one-shot, picks an action by whether the light is currently
//     off or on (e.g. If Off: On (Last), If On: Off is a toggle)
//   - Ramp Light: Ramp Up / Ramp Down starts a continuous ramp; Stop Ramp ends it
//
// e.g. Short release: Smart Step (toggle). Held for 250 / Release after 251:
// UI feedback and a second Smart Step (long press). Held for 1000: Ramp Light
// (Ramp Up). Release after 1001: Ramp Light (Stop Ramp), reset UI.
export function BuildSmartControlActions(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const entries = self.devicesOnBridge
		.map((device) => {
			const levelType = getDeviceLevelType(device)
			if (!levelType) return undefined
			const label = getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device)
			return { device, levelType, label }
		})
		.filter((entry) => entry !== undefined)
		.sort((a, b) => a.label.localeCompare(b.label))

	if (entries.length === 0) return {}

	// A switch can't ramp, so Ramp Light only offers dimmers.
	const dimmers = entries.filter((entry) => entry.levelType === 'dimmer')

	const actions: Record<string, CompanionActionDefinition> = {
		smart_step: {
			name: 'Smart Step (If Off / If On)',
			options: [
				{
					id: 'device',
					type: 'dropdown',
					label: 'Device',
					default: entries[0].device.SerialNumber,
					choices: entries.map((entry) => ({ id: entry.device.SerialNumber, label: entry.label })),
				},
				{
					id: 'if_off',
					type: 'dropdown',
					label: 'If Off',
					default: 'on',
					choices: STEP_ACTION_CHOICES,
				},
				{
					id: 'if_on',
					type: 'dropdown',
					label: 'If On',
					default: 'off',
					choices: STEP_ACTION_CHOICES,
				},
				{
					id: 'step_percent',
					type: 'number',
					label: 'Nudge Step (%)',
					description: 'Used when If Off or If On is set to Nudge Up/Down.',
					default: 10,
					min: 1,
					max: 100,
					isVisible: (opts) =>
						opts.if_off === 'nudge_up' ||
						opts.if_off === 'nudge_down' ||
						opts.if_on === 'nudge_up' ||
						opts.if_on === 'nudge_down',
				},
				{
					id: 'specific_value_percent',
					type: 'number',
					label: 'Specific Value (%)',
					description: 'Used when If Off or If On is set to On (Specific %).',
					range: true,
					default: 50,
					min: 0,
					max: 100,
					isVisible: (opts) => opts.if_off === 'specific' || opts.if_on === 'specific',
				},
				{
					id: 'fade_time_on',
					type: 'number',
					label: 'Fade Time, Turning/Stepping On (seconds)',
					default: 0.75,
					min: 0,
					max: 10,
					step: 0.25,
				},
				{
					id: 'fade_time_off',
					type: 'number',
					label: 'Fade Time, Turning Off (seconds)',
					default: 2.5,
					min: 0,
					max: 10,
					step: 0.25,
				},
			],
			callback: async (event) => {
				const device = self.devicesOnBridge.find((d) => d.SerialNumber === event.options.device)
				if (!device) return

				markLightSelected(self, device) // touching this light selects it for its room (and the house-wide fallback)

				const serial = device.SerialNumber
				const isOn = (self.currentLevel[serial] ?? 0) > 0
				const mode = ((isOn ? event.options.if_on : event.options.if_off) as string) || 'none'

				const level = resolveStepLevel(self, device, mode, event.options)
				if (level === undefined) return // 'none' -- do nothing

				const isDimmer = getDeviceLevelType(device) === 'dimmer'
				const fadeOn = (event.options.fade_time_on as number) ?? 0.75
				const fadeOff = (event.options.fade_time_off as number) ?? 2.5
				await sendLevel(self, device, level, isDimmer ? (level === 0 ? fadeOff : fadeOn) : 0)
			},
		},
	}

	if (dimmers.length > 0) {
		actions.ramp_light = {
			name: 'Ramp Light (Hold)',
			options: [
				{
					id: 'device',
					type: 'dropdown',
					label: 'Light',
					default: dimmers[0].device.SerialNumber,
					choices: dimmers.map((entry) => ({ id: entry.device.SerialNumber, label: entry.label })),
				},
				{
					id: 'ramp_mode',
					type: 'dropdown',
					label: 'Ramp',
					description:
						'Put Ramp Up/Down in a "Held for" duration group (execute while held), and Stop Ramp in the matching "Release after" group.',
					default: 'up',
					choices: RAMP_MODE_CHOICES,
				},
				{
					id: 'ramp_rate_percent_per_sec',
					type: 'number',
					label: 'Ramp Rate (%/sec)',
					default: 30,
					min: 1,
					max: 100,
					isVisible: (opts) => opts.ramp_mode !== 'stop',
				},
				{
					id: 'ramp_tick_ms',
					type: 'number',
					label: 'Ramp Update Interval (ms)',
					description:
						'How often the ramp steps. A Lutron zone handles about 6 commands/sec (~160ms each), so faster than that gains nothing -- the module sends only the newest level while the bridge is busy. Slower gives bigger, less frequent steps at the same Ramp Rate.',
					default: 200,
					min: 50,
					max: 1000,
					isVisible: (opts) => opts.ramp_mode !== 'stop',
				},
				{
					id: 'ramp_floor_percent',
					type: 'number',
					label: 'Ramp Floor (%)',
					description: 'Ramp Down stops here instead of going all the way to 0. Default 0 -- ramps all the way off.',
					range: true,
					default: 0,
					min: 0,
					max: 99,
					isVisible: (opts) => opts.ramp_mode === 'down',
				},
			],
			callback: async (event) => {
				const device = self.devicesOnBridge.find((d) => d.SerialNumber === event.options.device)
				if (!device) return

				const mode = event.options.ramp_mode as string
				if (mode === 'stop') {
					stopRamp(self, device.SerialNumber)
					return
				}

				markLightSelected(self, device)
				if (mode === 'up' || mode === 'down') startRamp(self, device, mode, event.options)
			},
		}
	}

	return actions
}

// Resolves a Smart Step mode (already picked for the light's current state) to
// the level to send, or undefined for 'none'.
function resolveStepLevel(
	self: ModuleInstance,
	device: DeviceDefinition,
	mode: string,
	options: CompanionOptionValues,
): number | undefined {
	if (mode === 'none') return undefined

	const serial = device.SerialNumber
	const step = (options.step_percent as number) || 10
	const specific = (options.specific_value_percent as number) ?? 50

	if (getDeviceLevelType(device) !== 'dimmer') {
		// A switch is only ever 0 or 100.
		if (mode === 'off' || mode === 'nudge_down') return 0
		if (mode === 'specific') return specific > 0 ? 100 : 0
		return 100
	}

	switch (mode) {
		case 'off':
			return 0
		case 'on':
			return self.lastNonZeroLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS
		case 'full':
			return 100
		case 'specific':
			return specific
		case 'nudge_up':
			return Math.min(100, (self.currentLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS) + step)
		case 'nudge_down':
			return Math.max(0, (self.currentLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS) - step)
		default:
			return undefined
	}
}

function startRamp(
	self: ModuleInstance,
	device: DeviceDefinition,
	direction: 'up' | 'down',
	options: CompanionOptionValues,
): void {
	const serial = device.SerialNumber
	stopRamp(self, serial)

	// Only meaningful for Ramp Down -- 0 (default) means "can ramp all the way
	// off". There's no equivalent ceiling below 100 for Ramp Up.
	const floor = direction === 'down' ? Math.max(0, Math.min(99, (options.ramp_floor_percent as number) || 0)) : 0

	const current = self.currentLevel[serial] ?? 0
	if (direction === 'down' && current <= floor) return // already at or below the floor -- nothing to ramp

	const state: SmartControlState = { rampDirection: direction, rampLevel: current }
	self.smartControlState[serial] = state

	const tickMs = (options.ramp_tick_ms as number) || 200
	const ratePerSec = (options.ramp_rate_percent_per_sec as number) || 30
	const perTick = Math.max(1, Math.round((ratePerSec * tickMs) / 1000))

	state.rampInterval = setInterval(() => {
		const next =
			direction === 'up'
				? Math.min(100, (state.rampLevel ?? 0) + perTick)
				: Math.max(floor, (state.rampLevel ?? 0) - perTick)
		state.rampLevel = next
		void sendLevel(self, device, next, 0)

		if (direction === 'up' ? next === 100 : next === floor) stopRamp(self, serial)
	}, tickMs)
}

function stopRamp(self: ModuleInstance, serial: string): void {
	const state = self.smartControlState[serial]
	if (!state) return
	if (state.rampInterval) clearInterval(state.rampInterval)
	delete self.smartControlState[serial]
}

// Called on module destroy/reconnect so no dangling setInterval outlives the
// module instance that scheduled it.
export function ClearAllSmartControlState(self: ModuleInstance): void {
	Object.keys(self.smartControlState).forEach((serial) => stopRamp(self, serial))
}
