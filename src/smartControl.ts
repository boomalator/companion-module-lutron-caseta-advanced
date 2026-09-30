import type { CompanionActionDefinition, CompanionOptionValues } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import type { DeviceDefinition } from 'lutron-leap'
import { getDeviceLevelType, getDeviceLabel } from './deviceTypes.js'
import { sendLevel, DEFAULT_UNKNOWN_BRIGHTNESS } from './levelControl.js'
import { markLightSelected } from './selectedLight.js'

export interface SmartControlState {
	pressedAt: number
	isRamping: boolean
	holdTimer?: ReturnType<typeof setTimeout>
	rampInterval?: ReturnType<typeof setInterval>
	rampDirection?: 'up' | 'down'
	rampLevel?: number
}

// Shared by Tap and Long-Press, and by both their If-Off and If-On choices --
// unconditional, atomic actions rather than named "if off do X, if on do Y"
// combos, since any such combo grows the choice list combinatorially. Every
// gesture's actual behavior is one of these, picked independently for whether
// the light happens to be off or on at release time.
const CONDITIONAL_ACTION_CHOICES = [
	{ id: 'off', label: 'Off' },
	{ id: 'on', label: 'On (Last)' },
	{ id: 'full', label: 'On (Full)' },
	{ id: 'specific', label: 'On (Specific %)' },
	{ id: 'nudge_up', label: 'Nudge Up (+Step%)' },
	{ id: 'nudge_down', label: 'Nudge Down (-Step%)' },
	{ id: 'none', label: 'Do Nothing' },
]

// Hold has no "auto" mode -- you pick a direction (or turn it off entirely),
// which reads clearer than trying to infer intent from current state, and
// leaves Tap/Long-Press free to cover whichever direction Hold doesn't.
const HOLD_MODE_CHOICES = [
	{ id: 'up', label: 'Ramp Up' },
	{ id: 'down', label: 'Ramp Down' },
	{ id: 'none', label: 'Do Nothing' },
]

// One generic action, wired in twice per button: once into its Press actions
// with Phase = Press, once into its Release actions with Phase = Release (both
// instances targeting the same Device). That's it -- no dependence on Companion's
// duration-group feature, just the plain press/release every surface has. Gives
// three independently-configurable gestures per button, aimed at running a
// light off one or two buttons:
//   - Tap:            (release before the tap threshold) If Off / If On, each
//                      one of CONDITIONAL_ACTION_CHOICES -- defaults reproduce
//                      a toggle (If Off: On (Last), If On: Off)
//   - Long-press:      (release between the two thresholds) same shape, its
//                      own If Off / If On -- defaults to If Off: On (Last),
//                      If On: Nudge Up (deliberately *not* On (Full) by
//                      default -- jumping to full brightness is a settled-for
//                      behavior of dumb switches, not something to default to)
//   - Press-and-hold:  continuous ramp for as long as it's held, in whichever
//                      direction Hold Mode picks (Ramp Up / Ramp Down / Do
//                      Nothing -- no "auto", so Tap/Long-Press are free to
//                      cover whichever direction Hold doesn't) -- simply stops
//                      in place on release, no discrete action fires
//                      afterward, since Tap/Long-Press are only ever evaluated
//                      when release happens *before* the ramp started
// e.g. Tap = Nudge Down (both If Off/If On), Hold = Ramp Up, Long-Press If Off
// = Off, If On = Off (i.e. Long-Press always turns it off).
// Switches (no dimming) only get the tap gesture; press/long-press/hold all
// just toggle.
export function BuildSmartControlAction(self: ModuleInstance): Record<string, CompanionActionDefinition> {
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

	return {
		smart_control: {
			name: 'Smart Control (Tap / Long-Press / Hold-to-Ramp)',
			options: [
				{
					id: 'device',
					type: 'dropdown',
					label: 'Device',
					default: entries[0].device.SerialNumber,
					choices: entries.map((entry) => ({ id: entry.device.SerialNumber, label: entry.label })),
				},
				{
					id: 'phase',
					type: 'dropdown',
					label: 'Phase',
					description:
						'Which of the button’s action lists this instance is in -- add this action once to Press actions with Phase=Press, and once to Release actions with Phase=Release.',
					default: 'press',
					choices: [
						{ id: 'press', label: 'Press' },
						{ id: 'release', label: 'Release' },
					],
				},
				{
					id: 'hold_threshold_ms',
					type: 'number',
					label: 'Hold Threshold (ms) -- how long held before it starts ramping',
					default: 1000,
					min: 100,
					max: 5000,
					isVisible: (opts) => opts.phase === 'press',
				},
				{
					id: 'hold_mode',
					type: 'dropdown',
					label: 'On Hold',
					default: 'up',
					choices: HOLD_MODE_CHOICES,
					isVisible: (opts) => opts.phase === 'press',
				},
				{
					id: 'ramp_rate_percent_per_sec',
					type: 'number',
					label: 'Ramp Rate (%/sec) while held',
					default: 30,
					min: 1,
					max: 100,
					isVisible: (opts) => opts.phase === 'press' && opts.hold_mode !== 'none',
				},
				{
					id: 'ramp_tick_ms',
					type: 'number',
					label: 'Ramp Update Interval (ms)',
					default: 150,
					min: 50,
					max: 1000,
					isVisible: (opts) => opts.phase === 'press' && opts.hold_mode !== 'none',
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
					isVisible: (opts) => opts.phase === 'press' && opts.hold_mode === 'down',
				},
				{
					id: 'tap_threshold_ms',
					type: 'number',
					label: 'Tap Threshold (ms) -- shorter releases are a tap',
					default: 250,
					min: 50,
					max: 5000,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'tap_if_off',
					type: 'dropdown',
					label: 'Tap, If Off',
					default: 'on',
					choices: CONDITIONAL_ACTION_CHOICES,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'tap_if_on',
					type: 'dropdown',
					label: 'Tap, If On',
					default: 'off',
					choices: CONDITIONAL_ACTION_CHOICES,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'long_press_if_off',
					type: 'dropdown',
					label: 'Long-Press, If Off',
					default: 'on',
					choices: CONDITIONAL_ACTION_CHOICES,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'long_press_if_on',
					type: 'dropdown',
					label: 'Long-Press, If On',
					default: 'nudge_up',
					choices: CONDITIONAL_ACTION_CHOICES,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'step_percent',
					type: 'number',
					label: 'Nudge Step (%)',
					description: 'Used by any of the four gesture choices above when set to Nudge Up/Down.',
					default: 10,
					min: 1,
					max: 100,
					isVisible: (opts) =>
						opts.phase === 'release' &&
						(opts.tap_if_off === 'nudge_up' ||
							opts.tap_if_off === 'nudge_down' ||
							opts.tap_if_on === 'nudge_up' ||
							opts.tap_if_on === 'nudge_down' ||
							opts.long_press_if_off === 'nudge_up' ||
							opts.long_press_if_off === 'nudge_down' ||
							opts.long_press_if_on === 'nudge_up' ||
							opts.long_press_if_on === 'nudge_down'),
				},
				{
					id: 'specific_value_percent',
					type: 'number',
					label: 'Specific Value (%)',
					description: 'Used by any of the four gesture choices above when set to On (Specific %).',
					range: true,
					default: 50,
					min: 0,
					max: 100,
					isVisible: (opts) =>
						opts.phase === 'release' &&
						(opts.tap_if_off === 'specific' ||
							opts.tap_if_on === 'specific' ||
							opts.long_press_if_off === 'specific' ||
							opts.long_press_if_on === 'specific'),
				},
				{
					id: 'fade_time_on',
					type: 'number',
					label: 'Fade Time, Turning/Stepping On (seconds)',
					default: 0.75,
					min: 0,
					max: 10,
					step: 0.25,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'fade_time_off',
					type: 'number',
					label: 'Fade Time, Turning Off (seconds)',
					default: 2.5,
					min: 0,
					max: 10,
					step: 0.25,
					isVisible: (opts) => opts.phase === 'release',
				},
			],
			callback: async (event) => {
				const device = self.devicesOnBridge.find((d) => d.SerialNumber === event.options.device)
				if (!device) return

				if (event.options.phase === 'release') {
					await handleRelease(self, device, event.options)
				} else {
					markLightSelected(self, device) // touching this light selects it for its room (and the house-wide fallback)
					handlePress(self, device, event.options)
				}
			},
		},
	}
}

function handlePress(self: ModuleInstance, device: DeviceDefinition, options: CompanionOptionValues): void {
	const serial = device.SerialNumber
	clearSmartControlState(self, serial)

	const state: SmartControlState = { pressedAt: Date.now(), isRamping: false }
	self.smartControlState[serial] = state

	if (getDeviceLevelType(device) !== 'dimmer') return // switches: no ramp, just time the tap

	const holdMode = (options.hold_mode as string) || 'up'
	if (holdMode === 'none') return // Hold disabled on this instance -- any release just resolves as tap/long-press

	const holdMs = (options.hold_threshold_ms as number) || 1000
	state.holdTimer = setTimeout(() => startRamp(self, device, options), holdMs)
}

function startRamp(self: ModuleInstance, device: DeviceDefinition, options: CompanionOptionValues): void {
	const serial = device.SerialNumber
	const state = self.smartControlState[serial]
	if (!state) return

	const holdMode = (options.hold_mode as string) || 'up'
	if (holdMode !== 'up' && holdMode !== 'down') return // 'none' is filtered out before scheduling; defensive only

	state.isRamping = true
	state.holdTimer = undefined
	state.rampDirection = holdMode

	// Only meaningful for Ramp Down -- 0 (default) means "can ramp all the way
	// off". There's no equivalent ceiling below 100 for Ramp Up.
	const floor = holdMode === 'down' ? Math.max(0, Math.min(99, (options.ramp_floor_percent as number) || 0)) : 0
	state.rampLevel = self.currentLevel[serial] ?? 0

	const tickMs = (options.ramp_tick_ms as number) || 150
	const ratePerSec = (options.ramp_rate_percent_per_sec as number) || 30
	const perTick = Math.max(1, Math.round((ratePerSec * tickMs) / 1000))

	state.rampInterval = setInterval(() => {
		const next =
			state.rampDirection === 'up'
				? Math.min(100, (state.rampLevel ?? 0) + perTick)
				: Math.max(floor, (state.rampLevel ?? 0) - perTick)
		state.rampLevel = next
		void sendLevel(self, device, next, 0)

		const reachedBound = state.rampDirection === 'up' ? next === 100 : next === floor
		if (reachedBound) {
			clearInterval(state.rampInterval)
			state.rampInterval = undefined
		}
	}, tickMs)
}

// Shared by Tap and Long-Press -- both resolve to one of
// CONDITIONAL_ACTION_CHOICES, already picked for the light's current state
// (the caller chose the If-Off or If-On option before calling this).
// Returns undefined for 'none' (do nothing).
function resolveGestureLevel(
	self: ModuleInstance,
	device: DeviceDefinition,
	mode: string,
	options: CompanionOptionValues,
): number | undefined {
	const serial = device.SerialNumber
	const step = (options.step_percent as number) || 10

	switch (mode) {
		case 'off':
			return 0
		case 'on':
			return self.lastNonZeroLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS
		case 'full':
			return 100
		case 'specific':
			return (options.specific_value_percent as number) ?? 50
		case 'nudge_up':
			return Math.min(100, (self.currentLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS) + step)
		case 'nudge_down':
			return Math.max(0, (self.currentLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS) - step)
		case 'none':
		default:
			return undefined
	}
}

async function handleRelease(
	self: ModuleInstance,
	device: DeviceDefinition,
	options: CompanionOptionValues,
): Promise<void> {
	const serial = device.SerialNumber
	const state = self.smartControlState[serial]
	// No matching press -- e.g. the Press/Release instances on this button were
	// pointed at different devices. Nothing to resolve.
	if (!state) return

	if (state.holdTimer) clearTimeout(state.holdTimer)
	if (state.rampInterval) clearInterval(state.rampInterval)
	const wasRamping = state.isRamping
	delete self.smartControlState[serial]

	// Held past the hold threshold: the ramp already applied the change live,
	// tick by tick. Releasing just stops it where it is -- no discrete action.
	if (wasRamping) return

	const elapsed = Date.now() - state.pressedAt
	const isOn = (self.currentLevel[serial] ?? 0) > 0
	const fadeOn = (options.fade_time_on as number) ?? 0.75
	const fadeOff = (options.fade_time_off as number) ?? 2.5

	if (getDeviceLevelType(device) !== 'dimmer') {
		// Switches: tap and long-press both just toggle.
		await sendLevel(self, device, isOn ? 0 : 100, 0)
		return
	}

	const isTap = elapsed < ((options.tap_threshold_ms as number) || 250)
	const mode = isTap
		? ((isOn ? options.tap_if_on : options.tap_if_off) as string)
		: ((isOn ? options.long_press_if_on : options.long_press_if_off) as string)

	const level = resolveGestureLevel(self, device, mode || 'none', options)
	if (level === undefined) return // 'none' -- do nothing

	await sendLevel(self, device, level, level === 0 ? fadeOff : fadeOn)
}

function clearSmartControlState(self: ModuleInstance, serial: string): void {
	const state = self.smartControlState[serial]
	if (!state) return
	if (state.holdTimer) clearTimeout(state.holdTimer)
	if (state.rampInterval) clearInterval(state.rampInterval)
	delete self.smartControlState[serial]
}

// Called on module destroy/reconnect so no dangling setInterval/setTimeout
// outlives the module instance that scheduled it.
export function ClearAllSmartControlState(self: ModuleInstance): void {
	Object.keys(self.smartControlState).forEach((serial) => clearSmartControlState(self, serial))
}
