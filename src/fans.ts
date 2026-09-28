import type { ModuleInstance } from './main.js'
import type {
	CompanionActionDefinition,
	CompanionVariableDefinition,
	CompanionVariableValues,
} from '@companion-module/base'
import type { DeviceDefinition, FanSpeedType } from 'lutron-leap'
import { isFanDevice, getDeviceLabel, slugify } from './deviceTypes.js'

// Confirmed against a live bridge (Floor Fan, Bathroom Fan): zone status for a
// CasetaFanSpeedController has a FanSpeed field only -- no Level -- with exactly
// these 5 values.
export const FAN_SPEED_CHOICES: FanSpeedType[] = ['Off', 'Low', 'Medium', 'MediumHigh', 'High']

export function BuildFanVariableDefinitions(self: ModuleInstance): CompanionVariableDefinition[] {
	const entries = self.devicesOnBridge
		.filter((device) => isFanDevice(device))
		.map((device) => ({ device, label: getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device) }))
		.sort((a, b) => a.label.localeCompare(b.label))

	const variables: CompanionVariableDefinition[] = []
	const usedIds = new Set<string>()

	self.fanVariableIds = {}
	entries.forEach(({ device, label }) => {
		let variableId = `${slugify(label)}_fan_speed`
		if (usedIds.has(variableId)) {
			variableId = `${slugify(label)}_${device.SerialNumber}_fan_speed`
		}
		usedIds.add(variableId)

		self.fanVariableIds[device.SerialNumber] = variableId
		variables.push({ variableId, name: label })
	})

	return variables
}

export function SeedFanVariableValues(self: ModuleInstance): void {
	const values: CompanionVariableValues = {}
	self.devicesOnBridge.forEach((device) => {
		if (!isFanDevice(device)) return
		const speed = self.currentFanSpeed[device.SerialNumber]
		const variableId = self.fanVariableIds[device.SerialNumber]
		if (speed !== undefined && variableId) {
			values[variableId] = speed
		}
	})
	self.setVariableValues(values)
}

export function BuildFanActions(self: ModuleInstance): Record<string, CompanionActionDefinition> {
	const entries = self.devicesOnBridge
		.filter((device) => isFanDevice(device))
		.map((device) => ({ device, label: getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device) }))
		.sort((a, b) => a.label.localeCompare(b.label))

	const actions: Record<string, CompanionActionDefinition> = {}
	entries.forEach(({ device, label }) => {
		actions[`${device.SerialNumber}_set_fan_speed`] = createFanSpeedAction(self, label, device)
	})
	return actions
}

function createFanSpeedAction(
	self: ModuleInstance,
	label: string,
	device: DeviceDefinition,
): CompanionActionDefinition {
	return {
		name: label,
		options: [
			{
				id: 'speed',
				type: 'dropdown',
				label: 'Speed',
				default: 'Off',
				choices: FAN_SPEED_CHOICES.map((speed) => ({ id: speed, label: speed })),
			},
		],
		callback: async (event) => {
			const speed = event.options.speed as FanSpeedType
			try {
				self.log('debug', `Setting ${device.Name} fan speed to ${speed}`)
				const response = await self.bridge?.client.request(
					'CreateRequest',
					`${device.LocalZones[0].href}/commandprocessor`,
					{
						Command: {
							CommandType: 'GoToFanSpeed',
							FanSpeedParameters: { FanSpeed: speed },
						},
					},
				)
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
		},
	}
}
