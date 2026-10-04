// Builds importable Companion page files (one button per switch) from a single hand-built
// reference button and a list of switches.
//
//   node generate-switch-pages.mjs
//
// Reads  reference-switch-button.json  (the Stairs button, plus the selected-light circle,
//                                       built for the reference switch below) and
//                                       switches.json.
// Writes switches-page-N.companionconfig.
//
// A switch is only ever on or off, so its button is simple: the name, an olive background
// while it is on, and a press that toggles it. Like a light's button it also has the dot in
// the corner that shows it is the last light touched in its room. Everything about the
// reference button is copied as-is; only what is specific to the switch is rewritten: the
// device id in the action, the module variable name in the feedback, the selected-light room
// variable and name, and the label.
//
// How a switch looks (room and label) comes from SWITCH_STYLES below, by Lutron area and
// name. A switch that isn't listed -- one you just added -- still gets a button, in an
// "Other" group with a label made from its name, so the script never stops over a new switch.
// Outdoor plug-in switches are switches like any other.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	CONNECTION_LABEL,
	autoLines,
	countOf,
	layoutGroups,
	lineLimitEm,
	makeId,
	validateLabels,
	writePages,
} from './page-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The switch the reference button was built for. These exact values are what the generator
// searches for in the reference button and replaces.
const REF = {
	serial: 66252105,
	variableId: 'stairs_stair_lights_state',
	roomVariableSlug: 'stairs',
	deviceName: 'Stair Lights',
	lines: ['Stairs'],
}

// The rooms, in the order they appear on the pages. Hardcoded for this house: a room's
// switches share a row, and a room is kept on one page when it fits. Switches with no entry
// in SWITCH_STYLES go in OTHER_ROOM, after all of these.
const ROOM_ORDER = ['Garage', 'House', 'Outside']
const OTHER_ROOM = 'Other'

// "<Lutron area>/<device name>" -> [room, [line 1, line 2]]. The second line is optional.
// Within a room, switches follow this order.
const SWITCH_STYLES = {
	'Garage Entry/Main Lights': ['Garage', ['Garage', 'Entry']],
	'Main Floor/Garage Door Power': ['Garage', ['Garage', 'Door']],
	'Main Floor/Garage Light 1': ['Garage', ['Garage', 'Light 1']],
	'Main Floor/Garage Light 2': ['Garage', ['Garage', 'Light 2']],
	'Main Floor/Garage Spare Power': ['Garage', ['Garage', 'Spare']],
	'Stairs/Stair Lights': ['House', ['Stairs']],
	'Main Floor/Mud Room Light': ['House', ['Mud', 'Room']],
	'Outside/Back Deck Lights': ['Outside', ['Back', 'Deck']],
	'Outside/Back Plug': ['Outside', ['Back', 'Plug']], // an outdoor plug-in switch
	'Outside/Driveway Light': ['Outside', ['Driveway']],
}

const styleKey = (sw) => `${sw.area}/${sw.name}`

const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'))
const reference = readJson('reference-switch-button.json')
const labelLimitEm = lineLimitEm(reference.style.layers.find((l) => l.id === 'text0')) // how much text fits on a label line

const switches = readJson('switches.json').map((sw) => {
	const style = SWITCH_STYLES[styleKey(sw)]
	if (!style) console.warn(`note: no style for "${styleKey(sw)}", using the generic one (add it to SWITCH_STYLES)`)
	return {
		...sw,
		room: style ? style[0] : OTHER_ROOM,
		buttonLines: style ? style[1] : autoLines(sw.name, labelLimitEm),
	}
})

// Deep-copies the reference button for one switch. Returns the new control plus how many of
// each substitution happened, so the caller can check nothing was missed.
function buildButton(sw) {
	const counts = { serial: 0, variable: 0, room: 0, deviceName: 0, label: 0 }
	const refLabel = REF.lines.join('\\n')

	function walk(node, path) {
		if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}/${i}`))
		if (node && typeof node === 'object') {
			const out = {}
			for (const [key, value] of Object.entries(node)) {
				if ((key === 'id' || key === 'overrideId' || key === '_id') && typeof value === 'string') {
					// layer ids are referenced by overrides, so keep those; regenerate entity ids
					out[key] = /^[A-Za-z0-9_-]{21}$/.test(value) && !isLayerId(path) ? makeId(sw.serial, path, key, value) : value
				} else if (key === 'device' && value && typeof value === 'object' && value.value === REF.serial) {
					out[key] = { ...value, value: sw.serial }
					counts.serial++
				} else {
					out[key] = walk(value, `${path}/${key}`)
				}
			}
			return out
		}
		if (typeof node === 'string') return rewriteString(node)
		return node
	}

	// Layer ids live under style.layers; entity and override ids everywhere else.
	function isLayerId(path) {
		return path.startsWith('/style/layers/') && path.split('/').length === 4
	}

	function rewriteString(text) {
		let result = text
		if (result === refLabel) {
			counts.label++
			result = sw.buttonLines.join('\\n')
		}
		const variableHits = countOf(result, REF.variableId)
		if (variableHits) {
			result = result.replaceAll(REF.variableId, sw.variableId)
			counts.variable += variableHits
		}
		const roomVariable = `room_${REF.roomVariableSlug}_selected_name`
		if (result.includes(roomVariable)) {
			result = result.replaceAll(roomVariable, `room_${sw.roomVariableSlug}_selected_name`)
			counts.room++
		}
		const quotedName = `"${REF.deviceName}"`
		if (result.includes(quotedName)) {
			result = result.replaceAll(quotedName, `"${sw.name}"`)
			counts.deviceName++
		}
		return result
	}

	return { control: walk(reference, ''), counts }
}

validateLabels(switches, styleKey, { allowDuplicates: true, limitEm: labelLimitEm })

// The rooms in ROOM_ORDER first, then anything that fell back to OTHER_ROOM. Within a room,
// switches follow the order of SWITCH_STYLES; ones with no entry keep the order in switches.json.
const styleOrder = (sw) => {
	const index = Object.keys(SWITCH_STYLES).indexOf(styleKey(sw))
	return index < 0 ? Infinity : index
}
const groups = [...ROOM_ORDER, OTHER_ROOM]
	.map((room) => ({
		name: room,
		items: switches.filter((s) => s.room === room).sort((a, b) => styleOrder(a) - styleOrder(b)),
	}))
	.filter((g) => g.items.length > 0)

writePages({
	dir: here,
	filePrefix: 'switches',
	pageTitle: 'Switches',
	pages: layoutGroups(groups),
	buildControl(sw) {
		const { control, counts } = buildButton(sw)
		// 1 device in the press action; 1 state variable in the feedback; the selected-light room
		// variable and name in the circle's feedback; and 1 label
		const expected = { serial: 1, variable: 1, room: 1, deviceName: 1, label: 1 }
		for (const [key, want] of Object.entries(expected)) {
			if (counts[key] !== want)
				throw new Error(`${styleKey(sw)}: expected ${want} "${key}" substitutions, made ${counts[key]}`)
		}
		return control
	},
	summarize: (page) => {
		const rooms = [...new Set(page.placed.map((p) => p.group))]
		return `${page.placed.length} switches (${rooms.map((r) => `${r} ${page.placed.filter((p) => p.group === r).length}`).join(', ')})`
	},
})
console.log(`Connection label expected on import: ${CONNECTION_LABEL}`)
