import type { ModuleInstance } from './main.js'
import type { CompanionActionDefinition } from '@companion-module/base'
import type { VirtualButtonDefinition } from 'lutron-leap'

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

export function BuildSceneActions(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const scenes = Object.values(self.scenes).sort((a, b) => a.Name.localeCompare(b.Name))

	const actions: Record<string, CompanionActionDefinition> = {}
	scenes.forEach((scene) => {
		actions[`scene_${scene.href.replace(/[^a-z0-9]+/gi, '_')}`] = createSceneAction(self, scene)
	})
	return actions
}

function createSceneAction(self: ModuleInstance, scene: VirtualButtonDefinition): CompanionActionDefinition {
	return {
		name: `Scene: ${scene.Name}`,
		options: [],
		callback: async () => {
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
	}
}
