import type { ModuleInstance } from './main.js'
import type { CompanionActionDefinition } from '@companion-module/base'

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

// One generic action with a Scene dropdown, instead of one action per scene --
// keeps the action list from growing by one entry every time a scene is added
// in the Lutron app, and makes it trivial to duplicate a button and just swap
// which scene it fires.
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
			],
			callback: async (event) => {
				const scene = self.scenes[event.options.scene as string]
				if (!scene) return

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
			},
		},
	}
}
