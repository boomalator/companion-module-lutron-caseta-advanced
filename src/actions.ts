import { CompanionActionDefinition } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { DeviceDefinition } from 'lutron-leap'
import { getDeviceLevelType, getDeviceLabel, type DeviceLevelType } from './deviceTypes.js'
import { BuildFanActions } from './fans.js'
import { BuildSceneActions, RefreshScenes } from './scenes.js'
import { BuildSmartControlAction } from './smartControl.js'
import { computeLevelForMode, sendLevel } from './levelControl.js'
import { BuildSelectedLightAction, markLightSelected } from './selectedLight.js'

export function UpdateActions(self: ModuleInstance): void {
	const entries = self.devicesOnBridge
		.map((device) => {
			const levelType = getDeviceLevelType(device)
			if (!levelType) return undefined
			const label = getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device)
			return { device, levelType, label }
		})
		.filter((entry) => entry !== undefined)
		.sort((a, b) => a.label.localeCompare(b.label))

	const deviceActions: Record<string, CompanionActionDefinition> = {}
	entries.forEach(({ device, levelType, label }) => {
		deviceActions[`${device.SerialNumber}_set_level`] = createLevelAction(self, label, device, levelType)
	})

	self.setActionDefinitions({
		...deviceActions,
		...BuildFanActions(self),
		...BuildSceneActions(self),
		...BuildSmartControlAction(self),
		...BuildSelectedLightAction(self),
		...createSystemActions(self),
	})
}

// Not tied to any device -- bridge/connection-level maintenance actions.
function createSystemActions(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	return {
		system_rescan_devices: {
			name: 'System: Rescan Devices',
			options: [],
			callback: async () => {
				self.log('info', 'Rescanning devices...')
				try {
					await self.rescanDevices()
					await self.refreshSlowExtras()
				} catch (err) {
					self.log('error', `Rescan failed: ${(err as Error).message}`)
				}
			},
		},
		system_reconnect_bridge: {
			name: 'System: Reconnect to Bridge',
			options: [],
			callback: async () => {
				self.log('info', 'Manual reconnect requested')
				await self.handleBridgeDisconnected()
			},
		},
		system_refresh_scenes: {
			name: 'System: Refresh Scenes',
			options: [],
			callback: async () => {
				self.log('info', 'Refreshing scenes...')
				await RefreshScenes(self)
				self.updateActions()
			},
		},
	}
}

function createLevelAction(
	self: ModuleInstance,
	label: string,
	device: DeviceDefinition,
	levelType: DeviceLevelType,
): CompanionActionDefinition {
	const options: CompanionActionDefinition['options'] = [
		{
			id: 'mode',
			type: 'dropdown',
			label: levelType === 'dimmer' ? 'Control' : 'State',
			default: 'on',
			choices:
				levelType === 'dimmer'
					? [
							{ id: 'on', label: 'On (Resume Last Level)' },
							{ id: 'full', label: 'Full (100%)' },
							{ id: 'off', label: 'Off' },
							{ id: 'value', label: 'Specific Value' },
							{ id: 'brighten', label: 'Brighten (+X%)' },
							{ id: 'dim', label: 'Dim (-X%)' },
						]
					: [
							{ id: 'on', label: 'On' },
							{ id: 'off', label: 'Off' },
						],
		},
	]

	if (levelType === 'dimmer') {
		options.push({
			id: 'brightness_value',
			type: 'number',
			label: 'Brightness Value',
			range: true,
			default: 50,
			min: 0,
			max: 100,
			isVisible: (opts) => opts.mode === 'value',
		})
		options.push({
			id: 'step_percent',
			type: 'number',
			label: 'Step Amount (%)',
			range: true,
			default: 10,
			min: 1,
			max: 100,
			isVisible: (opts) => opts.mode === 'brighten' || opts.mode === 'dim',
		})
		// Two fields (rather than one shared default) so "turning on" and "turning
		// off" can have different defaults -- a fast fade up, a slower fade down.
		options.push({
			id: 'fade_time_on',
			type: 'number',
			label: 'Fade Time (seconds)',
			default: 0.75,
			min: 0,
			max: 10,
			step: 0.25,
			range: true,
			isVisible: (opts) => opts.mode !== 'off',
		})
		options.push({
			id: 'fade_time_off',
			type: 'number',
			label: 'Fade Time (seconds)',
			default: 2.5,
			min: 0,
			max: 10,
			step: 0.25,
			range: true,
			isVisible: (opts) => opts.mode === 'off',
		})
	}

	return {
		name: label,
		options,
		callback: async (event) => {
			markLightSelected(self, device) // this button was pressed for this light -- it's now "selected" for its room (and the house-wide fallback)

			const mode = event.options.mode as string
			const level = computeLevelForMode(self, device, levelType, mode, event.options)

			const fadeTimeValue =
				levelType === 'dimmer'
					? ((mode === 'off' ? event.options.fade_time_off : event.options.fade_time_on) as number) || 0
					: 0

			await sendLevel(self, device, level, fadeTimeValue)
		},
	}
}
