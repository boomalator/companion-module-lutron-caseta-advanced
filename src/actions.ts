import { CompanionActionDefinition } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { getDeviceLevelType, getDeviceLabel } from './deviceTypes.js'
import { BuildSetFanAction } from './fans.js'
import { BuildSetSceneAction, RefreshScenes } from './scenes.js'
import { LoadSceneAssignments } from './sceneState.js'
import { BuildSmartControlActions } from './smartControl.js'
import { computeLevelForMode, sendLevel } from './levelControl.js'
import { BuildSelectedLightAction, markLightSelected } from './selectedLight.js'

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({
		...BuildSetControlAction(self),
		...BuildSetFanAction(self),
		...BuildSetSceneAction(self),
		...BuildSmartControlActions(self),
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
					// Scenes, occupancy and scene settings take many round trips, longer than Companion
					// waits for an action to finish, so they carry on in the background.
					void self.refreshSlowExtras().catch((err: Error) => self.log('error', `Refresh failed: ${err.message}`))
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
				// Reading what each scene sets is slower than Companion waits for an action, so it
				// finishes in the background and the scene variables are rebuilt when it is done.
				void LoadSceneAssignments(self)
					.then(() => self.updateVariableDefinitions())
					.catch((err: Error) => self.log('error', `Failed to load scene settings: ${err.message}`))
			},
		},
	}
}

// One generic action with a Device dropdown spanning both dimmers and
// switches, instead of one action per device. A switch is just a dimmer
// clamped to 0/100 as far as computeLevelForMode/sendLevel are concerned, so
// there's no functional reason to split them into separate actions -- only a
// cosmetic one (Brightness Value/Step/Fade Time are moot on a switch), and
// Selected Light Control already accepts that same tradeoff.
function BuildSetControlAction(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const entries = self.devicesOnBridge
		.filter((device) => getDeviceLevelType(device) !== undefined)
		.map((device) => ({ device, label: getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device) }))
		.sort((a, b) => a.label.localeCompare(b.label))

	if (entries.length === 0) return {}

	return {
		set_control: {
			name: 'Set Control',
			options: [
				{
					id: 'device',
					type: 'dropdown',
					label: 'Device',
					default: entries[0].device.SerialNumber,
					choices: entries.map((entry) => ({ id: entry.device.SerialNumber, label: entry.label })),
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
						{ id: 'value', label: 'Specific Value' },
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
				// Two fields (rather than one shared default) so "turning on" and
				// "turning off" can have different defaults -- a fast fade up, a
				// slower fade down. Moot for a switch, but harmless to leave visible.
				// Toggle shows both, since which one applies depends on the light's state.
				{
					id: 'fade_time_on',
					type: 'number',
					label: 'Fade Time, Turning On (seconds)',
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
				const device = self.devicesOnBridge.find((d) => d.SerialNumber === event.options.device)
				if (!device) return

				markLightSelected(self, device) // this button was pressed for this device -- it's now "selected" for its room (and the house-wide fallback)

				const levelType = getDeviceLevelType(device) ?? 'switch'
				const mode = event.options.mode as string
				const level = computeLevelForMode(self, device, levelType, mode, event.options)
				// Toggle fades by where it ends up: a fade down when it turns the light off.
				const fadingOff = mode === 'off' || (mode === 'toggle' && level === 0)
				const fadeTimeValue = ((fadingOff ? event.options.fade_time_off : event.options.fade_time_on) as number) || 0

				await sendLevel(self, device, level, fadeTimeValue)
			},
		},
	}
}
