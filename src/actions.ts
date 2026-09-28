import { CompanionActionDefinition } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { DeviceDefinition } from 'lutron-leap'
import { getDeviceLevelType, type DeviceLevelType } from './deviceTypes.js'

export function UpdateActions(self: ModuleInstance): void {
	const deviceActions: Record<string, CompanionActionDefinition> = {}

	self.devicesOnBridge.forEach((device) => {
		const levelType = getDeviceLevelType(device)
		if (!levelType) return

		const areaName = self.deviceAreaNames[device.SerialNumber] ?? ''
		deviceActions[`${device.SerialNumber}_set_level`] = createLevelAction(self, areaName, device, levelType)
	})

	self.setActionDefinitions({
		...deviceActions,
	})
}

function createLevelAction(
	self: ModuleInstance,
	areaName: string,
	device: DeviceDefinition,
	levelType: DeviceLevelType,
): CompanionActionDefinition {
	const options: CompanionActionDefinition['options'] = [
		{
			id: 'mode',
			type: 'dropdown',
			label: 'Action',
			default: 'on',
			choices:
				levelType === 'dimmer'
					? [
							{ id: 'on', label: 'On (Resume Last Level)' },
							{ id: 'full', label: 'Full (100%)' },
							{ id: 'off', label: 'Off' },
							{ id: 'value', label: 'Specific Value' },
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
			id: 'fade_time',
			type: 'number',
			label: 'Fade Time (seconds)',
			default: 4,
			min: 0,
			max: 10,
			step: 0.25,
			range: true,
		})
	}

	return {
		name: `${areaName} ${device.Name}: Set Level`,
		options,
		callback: async (event) => {
			const mode = event.options.mode as string
			let level: number
			switch (mode) {
				case 'off':
					level = 0
					break
				case 'full':
					level = 100
					break
				case 'value':
					level = event.options.brightness_value as number
					break
				case 'on':
				default:
					level = levelType === 'dimmer' ? (self.lastNonZeroLevel[device.SerialNumber] ?? 100) : 100
			}

			// fade time input is in seconds but needs to be formatted for the API. So 1.75 seconds becomes "00:00:01.7500"
			const fadeTimeValue = levelType === 'dimmer' ? (event.options.fade_time as number) || 0 : 0
			const fadeTimeFormatted = `00:00:${Math.floor(fadeTimeValue).toString().padStart(2, '0')}.${((fadeTimeValue % 1) * 10000).toFixed(0).padStart(4, '0')}`

			try {
				self.log('debug', `Setting ${device.Name} to ${level}% with fade time ${fadeTimeFormatted}`)
				const response = await self.bridge?.client.request(
					'CreateRequest',
					`${device.LocalZones[0].href}/commandprocessor`,
					{
						Command: {
							CommandType: 'GoToDimmedLevel',
							DimmedLevelParameters: { Level: level, FadeTime: fadeTimeFormatted },
						},
					},
				)
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
		},
	}
}
