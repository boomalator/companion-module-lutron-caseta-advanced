import type { ModuleInstance } from './main.js'
import type {
	CompanionActionDefinition,
	CompanionVariableDefinition,
	CompanionVariableValues,
} from '@companion-module/base'
import type { DeviceDefinition, FanSpeedType } from 'lutron-leap'
import { isFanDevice, getDeviceLabel, slugify } from './deviceTypes.js'
import { sendFanSpeed } from './levelControl.js'
import { markLightSelected } from './selectedLight.js'
import { FAN_SPEED_CHOICES, FAN_SPEED_PERCENT } from './fanTypes.js'

// Re-exported from fanTypes.ts (shared with selectedLight.ts) so existing
// imports of these two from here keep working unchanged.
export { FAN_SPEED_CHOICES, FAN_SPEED_PERCENT }

export function BuildFanVariableDefinitions(self: ModuleInstance): CompanionVariableDefinition[] {
	const entries = self.devicesOnBridge
		.filter((device) => isFanDevice(device))
		.map((device) => ({ device, label: getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device) }))
		.sort((a, b) => a.label.localeCompare(b.label))

	const variables: CompanionVariableDefinition[] = []
	const usedIds = new Set<string>()

	self.fanVariableIds = {}
	self.fanPercentVariableIds = {}
	entries.forEach(({ device, label }) => {
		let base = slugify(label)
		if (usedIds.has(`${base}_fan_speed`)) {
			base = `${slugify(label)}_${device.SerialNumber}`
		}
		usedIds.add(`${base}_fan_speed`)

		self.fanVariableIds[device.SerialNumber] = `${base}_fan_speed`
		self.fanPercentVariableIds[device.SerialNumber] = `${base}_fan_speed_percent`
		variables.push(
			{ variableId: `${base}_fan_speed`, name: label },
			{ variableId: `${base}_fan_speed_percent`, name: `${label} (Percent)` },
		)
	})

	return variables
}

export function SeedFanVariableValues(self: ModuleInstance): void {
	const values: CompanionVariableValues = {}
	self.devicesOnBridge.forEach((device) => {
		if (!isFanDevice(device)) return
		const speed = self.currentFanSpeed[device.SerialNumber]
		if (speed === undefined) return

		const variableId = self.fanVariableIds[device.SerialNumber]
		if (variableId) values[variableId] = speed

		const percentVariableId = self.fanPercentVariableIds[device.SerialNumber]
		if (percentVariableId) values[percentVariableId] = FAN_SPEED_PERCENT[speed]
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
				default: 'Medium',
				choices: FAN_SPEED_CHOICES.map((speed) => ({ id: speed, label: speed })),
			},
		],
		callback: async (event) => {
			markLightSelected(self, device) // this button was pressed for this fan -- it's now "selected" for its room (and the house-wide fallback)

			const speed = event.options.speed as FanSpeedType
			await sendFanSpeed(self, device, speed)
		},
	}
}
