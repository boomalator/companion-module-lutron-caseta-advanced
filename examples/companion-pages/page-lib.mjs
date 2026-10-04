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

// Checks every item's two-line label: at most two lines, each at most MAX_LINE_CHARS, and
// no two buttons with the same label (a warning instead when allowDuplicates is set).
// describe(item) names an item in messages.
export function validateLabels(items, describe, { allowDuplicates = false } = {}) {
	const seen = new Map()
	for (const item of items) {
		const lines = item.buttonLines
		if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2)
			throw new Error(`${describe(item)}: buttonLines must be 1-2 lines`)
		for (const line of lines) {
			if (line.length > MAX_LINE_CHARS)
				throw new Error(`${describe(item)}: "${line}" is over ${MAX_LINE_CHARS} characters`)
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
