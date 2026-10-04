import type { CompanionOptionValues } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import type { DeviceDefinition, FanSpeedType } from 'lutron-leap'
import type { DeviceLevelType } from './deviceTypes.js'

// Used when we genuinely have no live reading yet for a dimmer (e.g. right at
// startup, before its first status has arrived) -- a light should still turn on to
// *something* usable rather than snapping to full brightness or staying dark.
export const DEFAULT_UNKNOWN_BRIGHTNESS = 65

// Shared by the per-device level action and the surface-generic "Selected Light
// Control" action, which offer the same on/full/off/value/brighten/dim modes but
// resolve their target device differently (a fixed dropdown vs. whatever's
// currently selected on the surface that pressed the button).
export function computeLevelForMode(
	self: ModuleInstance,
	device: DeviceDefinition,
	levelType: DeviceLevelType,
	mode: string,
	options: CompanionOptionValues,
): number {
	const serial = device.SerialNumber
	switch (mode) {
		case 'toggle': {
			// On -> off; off -> back on. A switch is 0/100, a dimmer goes back to the last
			// non-zero level it had (or a sensible default if it has never been on).
			if ((self.currentLevel[serial] ?? 0) > 0) return 0
			return levelType === 'dimmer' ? (self.lastNonZeroLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS) : 100
		}
		case 'off':
			return 0
		case 'full':
			return 100
		case 'value':
			// A switch only ever has an on/off zone -- treat any configured value as a
			// simple threshold rather than trying to send it a mid-range level.
			return levelType === 'dimmer'
				? (options.brightness_value as number)
				: (options.brightness_value as number) > 0
					? 100
					: 0
		case 'brighten': {
			if (levelType !== 'dimmer') return 100
			const current = self.currentLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS
			const step = (options.step_percent as number) || 10
			return Math.min(100, current + step)
		}
		case 'dim': {
			if (levelType !== 'dimmer') return 0
			const current = self.currentLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS
			const step = (options.step_percent as number) || 10
			return Math.max(0, current - step)
		}
		case 'on':
		default:
			return levelType === 'dimmer' ? (self.lastNonZeroLevel[serial] ?? DEFAULT_UNKNOWN_BRIGHTNESS) : 100
	}
}

// Fade time input is in seconds but needs to be formatted for the API, e.g. 1.75
// seconds becomes "00:00:01.7500".
export function formatFadeTime(seconds: number): string {
	const clamped = Math.max(0, seconds)
	return `00:00:${Math.floor(clamped).toString().padStart(2, '0')}.${((clamped % 1) * 10000).toFixed(0).padStart(4, '0')}`
}

interface PendingLevel {
	device: DeviceDefinition
	level: number
	fadeSeconds: number
	done: Array<() => void>
}

// Per zone: whether a request is on the wire, and the newest command that arrived
// meanwhile. Measured on a real bridge, a zone only handles ~6 level commands/sec
// (~140ms each); a faster stream (a ramp, repeated nudges, a busy network) queues
// up at the bridge, and the light keeps moving for seconds after the input stops.
interface ZoneQueue {
	busy: boolean
	pending?: PendingLevel
}
const zoneQueues = new WeakMap<ModuleInstance, Map<string, ZoneQueue>>()

// At most one level request per zone is ever in flight. Commands that arrive
// meanwhile replace each other, so only the newest goes out next -- an older level
// is stale by then. The returned promise resolves once the command it was part of
// (its own, or the newer one that replaced it) has completed.
export async function sendLevel(
	self: ModuleInstance,
	device: DeviceDefinition,
	level: number,
	fadeSeconds: number,
): Promise<void> {
	const zone = device.LocalZones[0]
	if (!zone) return Promise.resolve()

	let queues = zoneQueues.get(self)
	if (!queues) zoneQueues.set(self, (queues = new Map()))
	let queue = queues.get(zone.href)
	if (!queue) queues.set(zone.href, (queue = { busy: false }))

	return new Promise<void>((resolve) => {
		const done = [...(queue.pending?.done ?? []), resolve]
		queue.pending = { device, level, fadeSeconds, done }
		if (!queue.busy) void drainZone(self, queue)
	})
}

async function drainZone(self: ModuleInstance, queue: ZoneQueue): Promise<void> {
	queue.busy = true
	try {
		while (queue.pending) {
			const { device, level, fadeSeconds, done } = queue.pending
			queue.pending = undefined
			await transmitLevel(self, device, level, fadeSeconds)
			done.forEach((resolve) => resolve())
		}
	} finally {
		queue.busy = false
	}
}

async function transmitLevel(
	self: ModuleInstance,
	device: DeviceDefinition,
	level: number,
	fadeSeconds: number,
): Promise<void> {
	const zone = device.LocalZones[0]
	if (!zone) return

	// A "Switched" zone (confirmed live: e.g. a garage door power relay) rejects
	// GoToDimmedLevel outright -- "only supported on Dimmed zones" -- and has no
	// fade concept of its own. Everything else (actual Dimmed zones, including
	// switch-type devices that happen to be Dimmed zones under the hood) keeps
	// using GoToDimmedLevel as before.
	const isSwitchedZone = self.zoneControlType[device.SerialNumber] === 'Switched'

	try {
		self.log(
			'debug',
			`Setting ${device.Name} to ${level}%${isSwitchedZone ? '' : ` with fade time ${formatFadeTime(fadeSeconds)}`}`,
		)
		const response = isSwitchedZone
			? await self.bridge?.client.request('CreateRequest', `${zone.href}/commandprocessor`, {
					Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: level }] },
				})
			: await self.bridge?.client.request('CreateRequest', `${zone.href}/commandprocessor`, {
					Command: {
						CommandType: 'GoToDimmedLevel',
						DimmedLevelParameters: { Level: level, FadeTime: formatFadeTime(fadeSeconds) },
					},
				})
		if (!response?.Header.StatusCode?.code || response.Header.StatusCode.code > 299) {
			const errorMessage = response?.Body && 'Message' in response.Body ? response.Body.Message : 'Unknown error'
			self.log(
				'error',
				`Error setting ${device.Name}: ${response?.Header.StatusCode?.code} ${response?.Header.StatusCode?.message} - ${errorMessage}`,
			)
		}
	} catch (err) {
		self.log('error', `Error setting ${device.Name}: ${(err as Error).message}`)
	}
}

export async function sendFanSpeed(self: ModuleInstance, device: DeviceDefinition, speed: FanSpeedType): Promise<void> {
	const zone = device.LocalZones[0]
	if (!zone) return

	try {
		self.log('debug', `Setting ${device.Name} fan speed to ${speed}`)
		const response = await self.bridge?.client.request('CreateRequest', `${zone.href}/commandprocessor`, {
			Command: {
				CommandType: 'GoToFanSpeed',
				FanSpeedParameters: { FanSpeed: speed },
			},
		})
		if (!response?.Header.StatusCode?.code || response.Header.StatusCode.code > 299) {
			const errorMessage = response?.Body && 'Message' in response.Body ? response.Body.Message : 'Unknown error'
			self.log(
				'error',
				`Error setting ${device.Name} fan speed: ${response?.Header.StatusCode?.code} ${response?.Header.StatusCode?.message} - ${errorMessage}`,
			)
		}
	} catch (err) {
		self.log('error', `Error setting ${device.Name} fan speed: ${(err as Error).message}`)
	}
}
