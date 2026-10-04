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

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const CONNECTION_ID = 'AfzmaKaWqt3TFs8k2uqDe' // the connection id the reference button's actions point at
const CONNECTION_LABEL = 'Caseta1' // the label used in $(Caseta1:...) references
const MAX_LINE_CHARS = 9

// Applied to every Smart Step's "Fade Time, Turning Off" regardless of what the
// reference button has, so one number controls how the sample pages dim off.
const FADE_TIME_OFF_SECONDS = 1.5

// Light buttons use only 13 of a page's slots, which keeps a page testable and
// fits small surfaces (e.g. a 5x3 Stream Deck). Row 2 leaves its last two
// columns for navigation. Companion's "Page Down" goes back, "Page Up" goes next.
const LIGHT_ROW_LENGTHS = [5, 5, 3] // rows 0 and 1: columns 0-4; row 2: columns 0-2
const NAV_BUTTONS = { 2: { 3: { type: 'pagedown' }, 4: { type: 'pageup' } } }
const SLOTS_PER_PAGE = LIGHT_ROW_LENGTHS.reduce((a, b) => a + b, 0)
const GRID_COLUMNS = 5
const GRID_ROWS = LIGHT_ROW_LENGTHS.length

const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'))
const reference = readJson('reference-button.json')
const devices = readJson('devices.json')

// Deterministic ids, so regenerating produces identical files (clean diffs).
const makeId = (...parts) => createHash('sha256').update(parts.join(':')).digest('base64url').slice(0, 21)

function countOf(string, needle) {
	return string.split(needle).length - 1
}

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

// ---- validate labels ----
for (const device of devices) {
	const lines = device.buttonLines
	if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2)
		throw new Error(`${device.name}: buttonLines must be 1-2 lines`)
	for (const line of lines) {
		if (line.length > MAX_LINE_CHARS) throw new Error(`${device.name}: "${line}" is over ${MAX_LINE_CHARS} characters`)
	}
}
const seenLabels = new Map()
for (const device of devices) {
	const key = device.buttonLines.join(' / ')
	if (seenLabels.has(key)) throw new Error(`duplicate button label "${key}": ${seenLabels.get(key)} and ${device.name}`)
	seenLabels.set(key, device.name)
}

// ---- layout ----
// Lights are grouped by Lutron area. Each area starts on a fresh row and is kept
// on one page when it fits (a page holds SLOTS_PER_PAGE lights); an area bigger
// than a page is split across pages. slots[] lists every light position on a page
// in reading order, as [row, column].
const slots = LIGHT_ROW_LENGTHS.flatMap((length, row) => Array.from({ length }, (_, column) => [row, column]))
const rowStarts = LIGHT_ROW_LENGTHS.map((_, row) => slots.findIndex(([r]) => r === row))

const areas = [...new Set(devices.map((d) => d.area))].sort((a, b) => a.localeCompare(b))
const pages = [{ placed: [], next: 0 }] // placed: { device, row, column }
for (const area of areas) {
	let queue = devices.filter((d) => d.area === area).sort((a, b) => a.name.localeCompare(b.name))
	while (queue.length > 0) {
		let page = pages[pages.length - 1]
		let start = rowStarts.find((s) => s >= page.next) // next fresh row
		// Move to a new page if the area doesn't fit in what's left of this one, unless
		// the area is larger than a whole page (then fill this page's remainder and wrap).
		const wholeAreaFits = start !== undefined && SLOTS_PER_PAGE - start >= queue.length
		if (start === undefined || (!wholeAreaFits && queue.length <= SLOTS_PER_PAGE)) {
			pages.push((page = { placed: [], next: 0 }))
			start = 0
		}
		const take = queue.slice(0, SLOTS_PER_PAGE - start)
		take.forEach((device, i) => {
			const [row, column] = slots[start + i]
			page.placed.push({ device, row, column })
		})
		page.next = start + take.length
		queue = queue.slice(take.length)
	}
}

// ---- write ----
// The connection block is intentionally bare: a raw Companion export embeds the
// connection's config and secrets (bridge certificates), which must never be
// published. On import Companion asks which connection to map this one to.
const instances = {
	[CONNECTION_ID]: {
		moduleInstanceType: 'connection',
		moduleId: 'lutron-caseta-advanced',
		moduleVersionId: 'dev',
		updatePolicy: 'stable',
		sortOrder: 0,
		label: CONNECTION_LABEL,
		isFirstInit: false,
		config: {},
		lastUpgradeIndex: -1,
		enabled: true,
	},
}

// Remove files from an earlier run, so a smaller page count doesn't leave stale pages behind.
for (const stale of readdirSync(here)) {
	if (/^lights-page-\d+\.companionconfig$/.test(stale)) rmSync(join(here, stale))
}

let total = 0
pages.forEach((page, pageIndex) => {
	const controls = {}
	for (const { device, row, column } of page.placed) {
		const { control, counts } = buildButton(device)
		// 4 device refs (2 Smart Step, 2 Ramp Light); 5 variable refs; 1 selected-light room
		// variable; 1 selected-light name; 1 label; 2 turn-off fade times (Smart Steps)
		const expected = { serial: 4, variable: 5, room: 1, deviceName: 1, label: 1, fadeOff: 2 }
		for (const [key, want] of Object.entries(expected)) {
			if (counts[key] !== want)
				throw new Error(`${device.name}: expected ${want} "${key}" substitutions, made ${counts[key]}`)
		}
		controls[row] ??= {}
		controls[row][column] = control
		total++
	}
	for (const [row, columns] of Object.entries(NAV_BUTTONS)) {
		controls[row] ??= {}
		Object.assign(controls[row], structuredClone(columns))
	}

	const pageNumber = pageIndex + 1
	const file = {
		version: 12,
		type: 'page',
		companionBuild: '5.0.6+9750-stable-1acd2318f5',
		page: {
			id: makeId('page', pageNumber),
			name: pages.length === 1 ? 'Lights' : `Lights ${pageNumber}`,
			controls,
			gridSize: { minColumn: 0, maxColumn: GRID_COLUMNS - 1, minRow: 0, maxRow: GRID_ROWS - 1 },
		},
		instances,
		connectionCollections: [],
		oldPageNumber: 1,
		imageLibrary: [],
		imageLibraryCollections: [],
	}

	const name = `lights-page-${pageNumber}.companionconfig`
	writeFileSync(join(here, name), JSON.stringify(file, null, '\t') + '\n')
	const byArea = [...new Set(page.placed.map((p) => p.device.area))].map(
		(area) => `${area} ${page.placed.filter((p) => p.device.area === area).length}`,
	)
	console.log(`${name}: ${page.placed.length} lights (${byArea.join(', ')})`)
})
console.log(`${total} buttons on ${pages.length} pages`)
