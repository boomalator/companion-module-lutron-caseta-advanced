import type { ModuleInstance } from './main.js'
import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import { getDeviceLevelType } from './deviceTypes.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const variables: CompanionVariableDefinition[] = []

	self.devicesOnBridge.forEach((device) => {
		if (!getDeviceLevelType(device)) return

		const areaName = self.deviceAreaNames[device.SerialNumber] ?? ''
		variables.push({
			variableId: `brightness_${device.SerialNumber}`,
			name: `${areaName} ${device.Name} Brightness`.trim(),
		})
	})

	self.setVariableDefinitions(variables)

	// Seed values for any status already received (subscriptions are set up before
	// this is called, so results may already be sitting in self.currentLevel).
	const initialValues: CompanionVariableValues = {}
	self.devicesOnBridge.forEach((device) => {
		const level = self.currentLevel[device.SerialNumber]
		if (level !== undefined) {
			initialValues[`brightness_${device.SerialNumber}`] = level
		}
	})
	self.setVariableValues(initialValues)
}
