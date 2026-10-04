import type { CompanionOptionValues } from '@companion-module/base'
import type { DeviceDefinition } from 'lutron-leap'
import type { ModuleInstance } from './main.js'
import { sendLevel } from './levelControl.js'

// Only a running ramp is stateful. Everything else about a button gesture is
// timed by Companion itself (see smartControl.ts), so the module keeps no press timers.
export interface SmartControlState {
	rampInterval?: ReturnType<typeof setInterval>
	rampDirection?: 'up' | 'down'
	rampLevel?: number
}

// Shared by Ramp Light (a fixed light) and Selected Light Control (whichever light was
// last touched in a room): both start and stop the same ramp, keyed by the light.
export const RAMP_MODE_CHOICES = [
	{ id: 'up', label: 'Start Ramp Up' },
	{ id: 'down', label: 'Start Ramp Down' },
	{ id: 'stop', label: 'Stop Ramp' },
]

export function startRamp(
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

export function stopRamp(self: ModuleInstance, serial: string): void {
	const state = self.smartControlState[serial]
	if (!state) return
	if (state.rampInterval) clearInterval(state.rampInterval)
	delete self.smartControlState[serial]
}

// Stops every running ramp on a light in the given room (Lutron area), or every ramp at
// all when room is undefined. Selected Light Control uses this for Stop Ramp: the light
// that was selected when the ramp started may not be the selected one by the time the
// button is released, and a ramp must never be left running.
export function stopRampsInRoom(self: ModuleInstance, room: string | undefined): void {
	for (const serial of Object.keys(self.smartControlState)) {
		if (room === undefined || self.deviceAreaNames[serial] === room) stopRamp(self, serial)
	}
}

// Called on module destroy/reconnect so no dangling setInterval outlives the
// module instance that scheduled it.
export function ClearAllSmartControlState(self: ModuleInstance): void {
	Object.keys(self.smartControlState).forEach((serial) => stopRamp(self, serial))
}
