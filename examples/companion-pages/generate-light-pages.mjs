// Builds importable Companion page files (one button per dimmer) from a single
// hand-built reference button and a list of devices.
//
//   node generate-light-pages.mjs
//
// Reads  reference-button.json  (a button exported from Companion, built for the
//                                reference device below) and  devices.json.
// Writes lights-page-N.companionconfig (JSON content; the .companionconfig
// extension is what Companion's Import file picker filters on).
//
// Everything about the reference button -- actions, duration groups, style,
// feedbacks, local variable -- is copied as-is. Only what is specific to the
// device is rewritten: the device id in the actions, the module variable names
// in the text/gauge/feedbacks, the selected-light room variable, and the label.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countOf, layoutGroups, makeId, validateLabels, writePages } from './page-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The device the reference button was built for. These exact values are what the
// generator searches for in the reference button and replaces.
const REF = {
	serial: 38014726,
	variableId: 'downstairs_den_window_lights_brightness',
	roomVariableSlug: 'downstairs',
	deviceName: 'Den Window Lights',
	lines: ['Den', 'Window'],
}

// Applied to every Smart Step's "Fade Time, Turning Off" regardless of what the
// reference button has, so one number controls how the sample pages dim off.
const FADE_TIME_OFF_SECONDS = 1.5

const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'))
const reference = readJson('reference-button.json')
const devices = readJson('devices.json')

// Deep-copies the reference button for one device. Returns the new control plus
// how many of each substitution happened, so callers can check nothing was missed.
function buildButton(device) {
	const counts = { serial: 0, variable: 0, room: 0, deviceName: 0, label: 0, fadeOff: 0 }
	const [line1, line2] = device.buttonLines
	const refLabel = `${REF.lines[0]}\\n${REF.lines[1]}\\n`

	function walk(node, path) {
		if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}/${i}`))
		if (node && typeof node === 'object') {
			const out = {}
			for (const [key, value] of Object.entries(node)) {
				if ((key === 'id' || key === 'overrideId' || key === '_id') && typeof value === 'string') {
					// layer/element ids are referenced by overrides, so keep those; regenerate entity ids
					out[key] =
						/^[A-Za-z0-9_-]{21}$/.test(value) && !isLayerId(path, key) ? makeId(device.serial, path, key, value) : value
				} else if (key === 'device' && value && typeof value === 'object' && value.value === REF.serial) {
					out[key] = { ...value, value: device.serial }
					counts.serial++
				} else if (key === 'fade_time_off' && value && typeof value.value === 'number') {
					out[key] = { ...value, value: FADE_TIME_OFF_SECONDS }
					counts.fadeOff++
				} else {
					out[key] = walk(value, `${path}/${key}`)
				}
			}
			return out
		}
		if (typeof node === 'string') return rewriteString(node)
		return node
	}

	// Layer ids live under style.layers; entity/override/stop ids everywhere else.
	function isLayerId(path) {
		return path.startsWith('/style/layers/') && path.split('/').length === 4
	}

	function rewriteString(text) {
		let result = text
		if (result.startsWith(refLabel)) {
			result = `${line1}\\n${line2}\\n` + result.slice(refLabel.length)
			counts.label++
		}
		const variableHits = countOf(result, REF.variableId)
		if (variableHits) {
			result = result.replaceAll(REF.variableId, device.variableId)
			counts.variable += variableHits
		}
		const roomVariable = `room_${REF.roomVariableSlug}_selected_name`
		if (result.includes(roomVariable)) {
			result = result.replaceAll(roomVariable, `room_${device.roomVariableSlug}_selected_name`)
			counts.room++
		}
		const quotedName = `"${REF.deviceName}"`
		if (result.includes(quotedName)) {
			result = result.replaceAll(quotedName, `"${device.name}"`)
			counts.deviceName++
		}
		return result
	}

	return { control: walk(reference, ''), counts }
}

validateLabels(devices, (d) => d.name)

// Lights are grouped by Lutron area (alphabetical), and each area's lights are sorted by name.
const areas = [...new Set(devices.map((d) => d.area))].sort((a, b) => a.localeCompare(b))
const groups = areas.map((area) => ({
	name: area,
	items: devices.filter((d) => d.area === area).sort((a, b) => a.name.localeCompare(b.name)),
}))

writePages({
	dir: here,
	filePrefix: 'lights',
	pageTitle: 'Lights',
	pages: layoutGroups(groups),
	buildControl(device) {
		const { control, counts } = buildButton(device)
		// 4 device refs (2 Smart Step, 2 Ramp Light); 5 variable refs; 1 selected-light room
		// variable; 1 selected-light name; 1 label; 2 turn-off fade times (Smart Steps)
		const expected = { serial: 4, variable: 5, room: 1, deviceName: 1, label: 1, fadeOff: 2 }
		for (const [key, want] of Object.entries(expected)) {
			if (counts[key] !== want)
				throw new Error(`${device.name}: expected ${want} "${key}" substitutions, made ${counts[key]}`)
		}
		return control
	},
	summarize: (page) => {
		const areaNames = [...new Set(page.placed.map((p) => p.group))]
		return `${page.placed.length} lights (${areaNames.map((a) => `${a} ${page.placed.filter((p) => p.group === a).length}`).join(', ')})`
	},
})
