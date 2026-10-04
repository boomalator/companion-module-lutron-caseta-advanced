import type { ModuleInstance } from './main.js'
import type { CompanionActionDefinition } from '@companion-module/base'
import type { VirtualButtonDefinition } from 'lutron-leap'
import { TurnSceneOff } from './sceneState.js'

// Lutron app-level "Scenes" (the home-wide ones in the app's Scenes tab, distinct
// from per-room AreaScenes) show up over LEAP as virtual buttons. Confirmed live:
// /virtualbutton returns a flat 100-slot list; only IsProgrammed ones are real,
// user-created scenes -- everything else is an unused placeholder slot.
export async function RefreshScenes(self: ModuleInstance): Promise<void> {
	const bridge = self.bridge
	if (!bridge) return

	self.scenes = {}

	try {
		const resp = await bridge.client.request('ReadRequest', '/virtualbutton')
		const body = resp.Body
		if (!body || !('VirtualButtons' in body)) return

		body.VirtualButtons.filter((vb) => vb.IsProgrammed).forEach((vb) => {
			self.scenes[vb.href] = vb
		})
		self.log('info', `Found ${Object.keys(self.scenes).length} programmed scenes`)
	} catch (err) {
		self.log('error', `Failed to read scenes: ${(err as Error).message}`)
	}
}

// One generic action with a Scene dropdown, instead of one action per scene -- keeps the
// action list from growing by one entry every time a scene is added in the Lutron app, and
// makes it trivial to duplicate a button and just swap which scene it fires.
//
// A scene is either active or it isn't, and the module works out which (sceneState.ts), so
// the Action option has no stored state of its own:
//   - Activate: press the scene (the default, and what a button made before this option
//     existed does)
//   - Turn Off: set every light the scene controls to off
//   - Toggle: turn it off if it is active, otherwise activate it
export function BuildSetSceneAction(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const scenes = Object.values(self.scenes).sort((a, b) => a.Name.localeCompare(b.Name))
	if (scenes.length === 0) return {}

	return {
		trigger_scene: {
			name: 'Trigger Scene',
			options: [
				{
					id: 'scene',
					type: 'dropdown',
					label: 'Scene',
					default: scenes[0].href,
					choices: scenes.map((scene) => ({ id: scene.href, label: scene.Name })),
				},
				{
					id: 'action',
					type: 'dropdown',
					label: 'Action',
					default: 'activate',
					choices: [
						{ id: 'activate', label: 'Activate' },
						{ id: 'off', label: 'Turn Off' },
						{ id: 'toggle', label: 'Toggle' },
					],
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
					isVisible: (opts) => opts.action === 'off' || opts.action === 'toggle',
				},
			],
			callback: async (event) => {
				const scene = self.scenes[event.options.scene as string]
				if (!scene) return

				// A button saved before the Action option existed has no value for it: activate.
				const action = (event.options.action as string | undefined) ?? 'activate'
				const turnOff = action === 'off' || (action === 'toggle' && self.sceneActive[scene.href])

				if (turnOff) {
					self.log('debug', `Turning scene off: ${scene.Name}`)
					await TurnSceneOff(self, scene.href, (event.options.fade_time_off as number | undefined) ?? 2.5)
				} else {
					await activateScene(self, scene)
				}
			},
		},
	}
}

async function activateScene(self: ModuleInstance, scene: VirtualButtonDefinition): Promise<void> {
	try {
		self.log('debug', `Activating scene: ${scene.Name}`)
		const response = await self.bridge?.client.request('CreateRequest', `${scene.href}/commandprocessor`, {
			Command: { CommandType: 'PressAndRelease' },
		})
		if (!response?.Header.StatusCode?.code || response.Header.StatusCode.code > 299) {
			const errorMessage = response?.Body && 'Message' in response.Body ? response.Body.Message : 'Unknown error'
			self.log(
				'error',
				`Error activating scene ${scene.Name}: ${response?.Header.StatusCode?.code} ${response?.Header.StatusCode?.message} - ${errorMessage}`,
			)
		}
	} catch (err) {
		self.log('error', `Error activating scene ${scene.Name}: ${(err as Error).message}`)
	}
}
