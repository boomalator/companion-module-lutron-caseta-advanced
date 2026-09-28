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

// Lutron's LEAP API never reports a numeric fan speed -- FanSpeed is always one of
// the 5 names above. This mapping is our own assumption (an even 25% step per
// speed), not something confirmed from Lutron documentation or the API itself.
// Provided as a convenience for button-text formatting/math alongside the
// authoritative text variable, not as a replacement for it.
export const FAN_SPEED_PERCENT: Record<FanSpeedType, number> = {
	Off: 0,
	Low: 25,
	Medium: 50,
	MediumHigh: 75,
	High: 100,
}

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
