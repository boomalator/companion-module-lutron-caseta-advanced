import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
	host: string
	port: number
	bridgeID?: string
	picoDeviceIds?: string[]
}

export interface ModuleSecrets {
	bridgeCerts?: BridgeCerts
}

export interface BridgeCerts {
	ca: string
	certificate: string
	privateKey: string
}

export function GetConfigFields(
	discoveredBridges: Record<string, string>,
	discoveredPicoDevices: Record<string, string>,
): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info1',
			width: 8,
			label: 'Pairing Instructions',
			value:
				'Select your Lutron Bridge from the dropdown below, or enter in the IP address manually. Then after you hit Save, press the black pairing button on your Lutron Bridge.',
		},
		{
			type: 'dropdown',
			id: 'host',
			label: 'Host',
			description: 'Enter the IP address of the bridge or select one from the dropdown.',
			width: 8,
			choices: Object.entries(discoveredBridges).map(([ipAddr, bridgeID]) => {
				return { id: ipAddr, label: `${ipAddr} (${bridgeID})` }
			}),
			default: '',
			regex: Regex.IP,
			allowCustom: true,
		} as SomeCompanionConfigField, // type assertion because description isn't in the base type definition
		{
			type: 'multidropdown',
			id: 'picoDeviceIds',
			label: 'Pico Remotes to Monitor',
			width: 8,
			description:
				'Select which Pico remotes should have their button presses exposed as variables. This list only populates after connecting once, so pair first, save, then come back to pick Picos.',
			choices: Object.entries(discoveredPicoDevices)
				.map(([serial, label]) => ({ id: serial, label }))
				.sort((a, b) => a.label.localeCompare(b.label)),
			default: [],
		} as SomeCompanionConfigField,
	]
}
