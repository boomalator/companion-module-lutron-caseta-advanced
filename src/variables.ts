import type { ModuleInstance } from './main.js'
import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import { getDeviceLevelType, getDeviceLabel, slugify } from './deviceTypes.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const entries = self.devicesOnBridge
		.map((device) => {
			const levelType = getDeviceLevelType(device)
			if (!levelType) return undefined
			const label = getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device)
			return { device, label, suffix: levelType === 'dimmer' ? 'brightness' : 'state' }
		})
		.filter((entry) => entry !== undefined)
		.sort((a, b) => a.label.localeCompare(b.label))

	const variables: CompanionVariableDefinition[] = []
	const usedIds = new Set<string>()

	self.deviceVariableIds = {}
	entries.forEach(({ device, label, suffix }) => {
		let variableId = `${slugify(label)}_${suffix}`
		if (usedIds.has(variableId)) {
			// disambiguate the rare case of two devices sharing the same area+name
			variableId = `${slugify(label)}_${device.SerialNumber}_${suffix}`
		}
		usedIds.add(variableId)

		self.deviceVariableIds[device.SerialNumber] = variableId
		variables.push({ variableId, name: label })
	})

	self.setVariableDefinitions(variables)

	// Seed values for any status already received (subscriptions are set up before
	// this is called, so results may already be sitting in self.currentLevel).
	const initialValues: CompanionVariableValues = {}
	entries.forEach(({ device }) => {
		const level = self.currentLevel[device.SerialNumber]
		const variableId = self.deviceVariableIds[device.SerialNumber]
		if (level !== undefined && variableId) {
			initialValues[variableId] = level
		}
	})
	self.setVariableValues(initialValues)
}
