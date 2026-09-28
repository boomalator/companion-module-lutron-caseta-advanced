import type { ModuleInstance } from './main.js'
import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import { isPicoDevice, getDeviceLabel, slugify } from './deviceTypes.js'

export const LAST_PRESSED_VARIABLE_ID = 'last_pico_button_pressed'

export interface PicoButtonState {
	deviceSerial: string
	deviceLabel: string
	buttonLabel: string
	fullLabel: string
	href: string
	isPressed: boolean
	sawLongHold: boolean
	pressCount: number
	longHoldCount: number
	variableIdIsPressed: string
	variableIdPressCount: string
	variableIdLongHoldCount: string
}

// Reads each selected Pico's buttons and subscribes to press/release/long-hold
// events for each one. Only devices the user picked in config are subscribed --
// with ~20 Picos on a bridge, most people only care about a handful of buttons.
export async function SubscribeToPicoButtons(self: ModuleInstance): Promise<void> {
	const bridge = self.bridge
	if (!bridge) return

	// SerialNumber is typed as string but Lutron's LEAP payload sends it as a JSON
	// number for some devices; String() it so Set.has() (no implicit coercion,
	// unlike object-key lookups elsewhere) actually matches config's saved strings.
	const selectedSerials = new Set(self.config.picoDeviceIds ?? [])
	const selectedPicoDevices = self.devicesOnBridge.filter(
		(device) => isPicoDevice(device) && selectedSerials.has(String(device.SerialNumber)),
	)

	self.picoButtons = {}

	await Promise.all(
		selectedPicoDevices.map(async (device) => {
			const deviceLabel = getDeviceLabel(self.deviceAreaNames[device.SerialNumber] ?? '', device)

			let groups
			try {
				groups = await bridge.getButtonGroupsFromDevice(device)
			} catch (err) {
				self.log('error', `Failed to read button groups for ${deviceLabel}: ${(err as Error).message}`)
				return
			}

			for (const group of groups) {
				if ('Message' in group) {
					self.log('warn', `Button group error for ${deviceLabel}: ${group.Message}`)
					continue
				}

				let buttons
				try {
					buttons = await bridge.getButtonsFromGroup(group)
				} catch (err) {
					self.log('error', `Failed to read buttons for ${deviceLabel}: ${(err as Error).message}`)
					continue
				}

				for (const button of buttons) {
					const buttonLabel = button.Engraving?.Text || button.Name || `Button ${button.ButtonNumber}`
					const fullLabel = `${deviceLabel} - ${buttonLabel}`

					const state: PicoButtonState = {
						deviceSerial: device.SerialNumber,
						deviceLabel,
						buttonLabel,
						fullLabel,
						href: button.href,
						isPressed: false,
						sawLongHold: false,
						pressCount: 0,
						longHoldCount: 0,
						variableIdIsPressed: '',
						variableIdPressCount: '',
						variableIdLongHoldCount: '',
					}
					self.picoButtons[button.href] = state

					try {
						await bridge.client.subscribe(`${button.href}/status/event`, (resp) => {
							const body = resp.Body
							if (!body || !('ButtonStatus' in body)) return
							HandlePicoButtonEvent(self, state, body.ButtonStatus.ButtonEvent.EventType)
						})
					} catch (err) {
						self.log('warn', `Failed to subscribe to button ${fullLabel}: ${(err as Error).message}`)
					}
				}
			}
		}),
	)
}

export function HandlePicoButtonEvent(
	self: ModuleInstance,
	state: PicoButtonState,
	eventType: 'Press' | 'Release' | 'LongHold',
): void {
	const values: CompanionVariableValues = {}

	switch (eventType) {
		case 'Press':
			state.isPressed = true
			state.sawLongHold = false
			self.log('info', `Button pressed: ${state.fullLabel}`)
			values[LAST_PRESSED_VARIABLE_ID] = state.fullLabel
			break
		case 'LongHold':
			state.sawLongHold = true
			break
		case 'Release':
			state.isPressed = false
			if (state.sawLongHold) {
				state.longHoldCount++
				if (state.variableIdLongHoldCount) values[state.variableIdLongHoldCount] = state.longHoldCount
			} else {
				state.pressCount++
				if (state.variableIdPressCount) values[state.variableIdPressCount] = state.pressCount
			}
			break
	}

	if (state.variableIdIsPressed) {
		values[state.variableIdIsPressed] = state.isPressed
	}
	self.setVariableValues(values)
}

export function BuildPicoVariableDefinitions(self: ModuleInstance): CompanionVariableDefinition[] {
	const variables: CompanionVariableDefinition[] = [
		{ variableId: LAST_PRESSED_VARIABLE_ID, name: 'Last Pico Button Pressed' },
	]
	const usedIds = new Set<string>([LAST_PRESSED_VARIABLE_ID])

	const entries = Object.values(self.picoButtons).sort((a, b) => a.fullLabel.localeCompare(b.fullLabel))

	entries.forEach((state) => {
		let base = slugify(state.fullLabel)
		if (usedIds.has(`${base}_is_pressed`)) {
			// disambiguate the rare case of two buttons slugifying to the same label
			base = `${base}_${state.deviceSerial}`
		}
		state.variableIdIsPressed = `${base}_is_pressed`
		state.variableIdPressCount = `${base}_press_count`
		state.variableIdLongHoldCount = `${base}_long_hold_count`
		usedIds.add(state.variableIdIsPressed)

		variables.push(
			{ variableId: state.variableIdIsPressed, name: state.fullLabel },
			{ variableId: state.variableIdPressCount, name: `${state.fullLabel} Press Count` },
			{ variableId: state.variableIdLongHoldCount, name: `${state.fullLabel} Long Hold Count` },
		)
	})

	return variables
}

export function SeedPicoVariableValues(self: ModuleInstance): void {
	const values: CompanionVariableValues = {}
	Object.values(self.picoButtons).forEach((state) => {
		if (state.variableIdIsPressed) values[state.variableIdIsPressed] = state.isPressed
		if (state.variableIdPressCount) values[state.variableIdPressCount] = state.pressCount
		if (state.variableIdLongHoldCount) values[state.variableIdLongHoldCount] = state.longHoldCount
	})
	self.setVariableValues(values)
}
