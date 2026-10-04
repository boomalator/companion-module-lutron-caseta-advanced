// Shared by generate-light-pages.mjs and generate-scene-pages.mjs: page layout,
// navigation buttons, and writing importable .companionconfig files.

import { createHash } from 'node:crypto'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONNECTION_ID = 'AfzmaKaWqt3TFs8k2uqDe' // the connection id the reference buttons' actions point at
export const CONNECTION_LABEL = 'Caseta1' // the label used in $(Caseta1:...) references
export const MAX_LINE_CHARS = 9

// Both kinds of page use only 13 of a page's slots, which keeps a page testable and
// fits small surfaces (e.g. a 5x3 Stream Deck). Row 2 leaves its last two columns for
// navigation. Companion's "Page Down" goes back, "Page Up" goes next.
const ROW_LENGTHS = [5, 5, 3] // rows 0 and 1: columns 0-4; row 2: columns 0-2
const NAV_BUTTONS = { 2: { 3: { type: 'pagedown' }, 4: { type: 'pageup' } } }
const GRID_COLUMNS = 5
export const SLOTS_PER_PAGE = ROW_LENGTHS.reduce((a, b) => a + b, 0)

// Deterministic ids, so regenerating produces identical files (clean diffs).
export const makeId = (...parts) => createHash('sha256').update(parts.join(':')).digest('base64url').slice(0, 21)

export function countOf(string, needle) {
	return string.split(needle).length - 1
}

// Button text is drawn in Companion's default font, Arimo, and a line wider than its text
// layer wraps onto another line. So "at most two lines" has to be checked by width, not by
// counting characters: "Spare Pwr" is nine characters but wraps, "Driveway" is eight and
// doesn't. These are Arimo's advance widths, in thousandths of an em, for the printable
// ASCII characters (32 to 126); anything else is assumed to be 0.7 em.
const ARIMO_WIDTHS = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
	556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
	722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
	556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
	260, 334, 584,
]

// Companion lays text out at a fixed height and wraps a line at the first space, hyphen,
// underscore, colon or tilde that lets it fit, or mid-word when there is none. Measured on a
// real button, a line has to be a little over its nominal width before it wraps ("Driveway",
// 4.11 em in a 4.0 em box, did not), so a line only counts as too wide beyond this factor.
const WRAP_TOLERANCE = 1.05
const BREAK_CHARACTERS = ' -_:~'

export function textWidthEm(text) {
	let total = 0
	for (const character of text) {
		const code = character.codePointAt(0)
		total += code >= 32 && code <= 126 ? ARIMO_WIDTHS[code - 32] : 700
	}
	return total / 1000
}

// How many em of text fit on one line of a text layer: the layer's width over its text size
// (Companion's text size is a percentage of the layer's own height). Pass the reference
// button's text layer.
export function lineLimitEm(layer) {
	return layer.width.value / layer.height.value / (layer.fontsize.value / 100)
}

const fitsOnLine = (text, limitEm) => textWidthEm(text) <= limitEm * WRAP_TOLERANCE

// How many lines one line of text is drawn as, wrapping the way Companion does.
function drawnLines(line, limitEm) {
	let rest = line
	let count = 0
	for (;;) {
		count++
		if (fitsOnLine(rest, limitEm)) return count
		let length = rest.length
		while (length > 1 && !fitsOnLine(rest.slice(0, length), limitEm)) length--
		let breakAt = length - 1
		for (let i = length - 1; i > 0; i--) {
			if (BREAK_CHARACTERS.includes(rest[i])) {
				breakAt = i
				break
			}
		}
		rest = rest.slice(breakAt + 1).replace(/^ /, '')
		if (rest === '') return count
	}
}

// A label for something with no hand-written one: its words wrapped onto two lines of at most
// MAX_LINE_CHARS characters that fit the layer (limitEm, see lineLimitEm), cut off if the
// name is too long.
export function autoLines(name, limitEm = Infinity) {
	const fits = (text) => text.length <= MAX_LINE_CHARS && fitsOnLine(text, limitEm)
	const truncate = (text) => {
		let cut = text
		while (cut.length > 1 && !fits(cut)) cut = cut.slice(0, -1)
		return cut
	}

	const lines = []
	let current = ''
	for (const word of name.trim().split(/\s+/)) {
		const candidate = current === '' ? word : `${current} ${word}`
		if (fits(candidate)) {
			current = candidate
			continue
		}
		if (current !== '') {
			lines.push(current)
			if (lines.length === 2) return lines // the rest of the name doesn't fit on two lines
		}
		current = truncate(word) // a single word too wide for a line is cut short
	}
	if (current !== '' && lines.length < 2) lines.push(current)
	return lines
}

// Checks every item's two-line label: at most two lines, each at most MAX_LINE_CHARS and no
// wider than the layer (limitEm, see lineLimitEm) so that nothing wraps into a third line, and
// no two buttons with the same label (a warning instead when allowDuplicates is set).
// describe(item) names an item in messages.
export function validateLabels(items, describe, { allowDuplicates = false, limitEm = Infinity } = {}) {
	const seen = new Map()
	for (const item of items) {
		const lines = item.buttonLines
		if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2)
			throw new Error(`${describe(item)}: buttonLines must be 1-2 lines`)
		for (const line of lines) {
			if (line.length > MAX_LINE_CHARS)
				throw new Error(`${describe(item)}: "${line}" is over ${MAX_LINE_CHARS} characters`)
		}
		const drawn = lines.reduce((total, line) => total + drawnLines(line, limitEm), 0)
		if (drawn > 2) {
			throw new Error(
				`${describe(item)}: "${lines.join(' / ')}" is drawn as ${drawn} lines at this button's text size (the limit is 2)`,
			)
		}
		const key = lines.join(' / ')
		if (seen.has(key)) {
			const message = `duplicate button label "${key}": ${seen.get(key)} and ${describe(item)}`
			if (!allowDuplicates) throw new Error(message)
			console.warn(`warning: ${message}`)
		}
		seen.set(key, describe(item))
	}
}

// groups: [{ name, items }] in the order they should appear. Each group starts on a fresh
// row and is kept on one page when it fits; a group bigger than a page is split across
// pages. Returns [{ placed: [{ item, group, row, column }] }].
export function layoutGroups(groups) {
	const slots = ROW_LENGTHS.flatMap((length, row) => Array.from({ length }, (_, column) => [row, column]))
	const rowStarts = ROW_LENGTHS.map((_, row) => slots.findIndex(([r]) => r === row))

	const pages = [{ placed: [], next: 0 }]
	for (const group of groups) {
		let queue = [...group.items]
		while (queue.length > 0) {
			let page = pages[pages.length - 1]
			let start = rowStarts.find((s) => s >= page.next) // next fresh row
			// Move to a new page if the group doesn't fit in what's left of this one, unless
			// the group is larger than a whole page (then fill this page's remainder and wrap).
			const wholeGroupFits = start !== undefined && SLOTS_PER_PAGE - start >= queue.length
			if (start === undefined || (!wholeGroupFits && queue.length <= SLOTS_PER_PAGE)) {
				pages.push((page = { placed: [], next: 0 }))
				start = 0
			}
			const take = queue.slice(0, SLOTS_PER_PAGE - start)
			take.forEach((item, i) => {
				const [row, column] = slots[start + i]
				page.placed.push({ item, group: group.name, row, column })
			})
			page.next = start + take.length
			queue = queue.slice(take.length)
		}
	}
	return pages.map(({ placed }) => ({ placed }))
}

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

// Writes one <filePrefix>-page-N.companionconfig per page (JSON content; the extension is
// what Companion's Import file picker filters on), removing files from an earlier run so a
// smaller page count doesn't leave stale pages behind. buildControl(item) returns the
// finished button for an item.
export function writePages({ dir, filePrefix, pageTitle, pages, buildControl, summarize }) {
	const stale = new RegExp(`^${filePrefix}-page-\\d+\\.companionconfig$`)
	for (const file of readdirSync(dir)) if (stale.test(file)) rmSync(join(dir, file))

	let total = 0
	pages.forEach((page, pageIndex) => {
		const controls = {}
		for (const { item, row, column } of page.placed) {
			controls[row] ??= {}
			controls[row][column] = buildControl(item)
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
				name: pages.length === 1 ? pageTitle : `${pageTitle} ${pageNumber}`,
				controls,
				gridSize: { minColumn: 0, maxColumn: GRID_COLUMNS - 1, minRow: 0, maxRow: ROW_LENGTHS.length - 1 },
			},
			instances,
			connectionCollections: [],
			oldPageNumber: 1,
			imageLibrary: [],
			imageLibraryCollections: [],
		}

		const name = `${filePrefix}-page-${pageNumber}.companionconfig`
		writeFileSync(join(dir, name), JSON.stringify(file, null, '\t') + '\n')
		console.log(`${name}: ${summarize(page)}`)
	})
	console.log(`${total} buttons on ${pages.length} pages`)
}
