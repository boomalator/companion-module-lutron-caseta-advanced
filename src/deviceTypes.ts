import type { DeviceDefinition } from 'lutron-leap'

export type DeviceLevelType = 'dimmer' | 'switch'

// Devices whose zone Level can be any value 0-100
const DIMMER_DEVICE_TYPES = ['WallDimmer', 'DivaSmartDimmer', 'PlugInDimmer']

// Devices whose zone Level is only ever 0 or 100
const SWITCH_DEVICE_TYPES = ['WallSwitch', 'DivaSmartSwitch', 'OutdoorPlugInSwitch']

export function getDeviceLevelType(device: DeviceDefinition): DeviceLevelType | undefined {
	if (DIMMER_DEVICE_TYPES.includes(device.DeviceType)) return 'dimmer'
	if (SWITCH_DEVICE_TYPES.includes(device.DeviceType)) return 'switch'
	return undefined
}

// Shared by actions.ts (action name) and variables.ts (variable name), so the two
// line up and both lists sort/scan the same way.
export function getDeviceLabel(areaName: string, device: DeviceDefinition): string {
	return `${areaName} ${device.Name}`.trim()
}

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}
