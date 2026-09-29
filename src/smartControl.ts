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

const LONG_PRESS_CHOICES = [
	{ id: 'full_or_nudge', label: 'Full On (if off) / Nudge by Step % (if on)' },
	{ id: 'toggle', label: 'Same as Tap (Resume/Off)' },
	{ id: 'none', label: 'Do Nothing' },
]

// One generic action, wired in twice per button: once into its Press actions
// with Phase = Press, once into its Release actions with Phase = Release (both
// instances targeting the same Device). That's it -- no dependence on Companion's
// duration-group feature, just the plain press/release every surface has. Gives
// three gestures per button, aimed at running a light off one or two buttons:
//   - Tap:            toggle -- resume last level, or turn off
//   - Long-press:      (release between the two thresholds) a single discrete
//                       step -- full on if it was off, or nudge brighter by a
//                       configurable % if it was already on
//   - Press-and-hold:  continuous ramp for as long as it's held -- dims up from
//                       off, or down towards off -- and simply stops in place on
//                       release (no separate discrete action fires afterward,
//                       since long-press is only evaluated when release happens
//                       *before* the ramp ever started)
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
					id: 'ramp_rate_percent_per_sec',
					type: 'number',
					label: 'Ramp Rate (%/sec) while held',
					default: 30,
					min: 1,
					max: 100,
					isVisible: (opts) => opts.phase === 'press',
				},
				{
					id: 'ramp_tick_ms',
					type: 'number',
					label: 'Ramp Update Interval (ms)',
					default: 150,
					min: 50,
					max: 1000,
					isVisible: (opts) => opts.phase === 'press',
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
					id: 'long_press_mode',
					type: 'dropdown',
					label: 'On Long-Press Release',
					default: 'full_or_nudge',
					choices: LONG_PRESS_CHOICES,
					isVisible: (opts) => opts.phase === 'release',
				},
				{
					id: 'step_percent',
					type: 'number',
					label: 'Long-Press Nudge (%)',
					default: 10,
					min: 1,
					max: 100,
					isVisible: (opts) => opts.phase === 'release' && opts.long_press_mode === 'full_or_nudge',
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

	const holdMs = (options.hold_threshold_ms as number) || 1000
	state.holdTimer = setTimeout(() => startRamp(self, device, options), holdMs)
}

function startRamp(self: ModuleInstance, device: DeviceDefinition, options: CompanionOptionValues): void {
	const serial = device.SerialNumber
	const state = self.smartControlState[serial]
	if (!state) return

	state.isRamping = true
	state.holdTimer = undefined

	const current = self.currentLevel[serial] ?? 0
	state.rampDirection = current > 0 ? 'down' : 'up'
	state.rampLevel = current

	const tickMs = (options.ramp_tick_ms as number) || 150
	const ratePerSec = (options.ramp_rate_percent_per_sec as number) || 30
	const perTick = Math.max(1, Math.round((ratePerSec * tickMs) / 1000))

	state.rampInterval = setInterval(() => {
		const next =
			state.rampDirection === 'up'
				? Math.min(100, (state.rampLevel ?? 0) + perTick)
				: Math.max(0, (state.rampLevel ?? 0) - perTick)
		state.rampLevel = next
		void sendLevel(self, device, next, 0)

		if (next === 0 || next === 100) {
			clearInterval(state.rampInterval)
			state.rampInterval = undefined
		}
	}, tickMs)
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

	if (elapsed < ((options.tap_threshold_ms as number) || 250)) {
		// TAP: resume last non-zero level, or turn off.
		const level = isOn ? 0 : (self.lastNonZeroLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS)
		await sendLevel(self, device, level, isOn ? fadeOff : fadeOn)
		return
	}

	// LONG PRESS: held past the tap threshold, but released before the ramp
	// kicked in at the hold threshold.
	const mode = (options.long_press_mode as string) || 'full_or_nudge'
	if (mode === 'none') return

	if (mode === 'toggle') {
		const level = isOn ? 0 : (self.lastNonZeroLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS)
		await sendLevel(self, device, level, isOn ? fadeOff : fadeOn)
		return
	}

	// 'full_or_nudge', matching the requested "if off, go full; if on, nudge" behavior.
	if (!isOn) {
		await sendLevel(self, device, 100, fadeOn)
	} else {
		const step = (options.step_percent as number) || 10
		const next = Math.min(100, (self.currentLevel[serial] ?? 0) + step)
		await sendLevel(self, device, next, fadeOn)
	}
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
