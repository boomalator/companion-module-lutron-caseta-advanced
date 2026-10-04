// Builds importable Companion page files (one button per Lutron scene) from a single
// hand-built reference button and a list of scenes.
//
//   node generate-scene-pages.mjs
//
// Reads  reference-scene-button.json  (a button exported from Companion, built for the
//                                      reference scene below) and  scenes.json  (each
//                                      scene's name and bridge id, as the bridge reports them).
// Writes scenes-page-N.companionconfig.
//
// The reference button's style, actions and feedbacks are copied as-is. Only what is specific
// to the scene is rewritten: the scene it triggers, the two-line label, the pictogram, and the
// "scene is active" variable in its feedback. A scene whose name contains the word "off" gets
// a plain button instead -- press to activate, always black -- because there is nothing for
// an "off" scene to turn off or to show as active.
//
// How a scene looks (room, label, pictogram) comes from SCENE_STYLES below, by scene name.
// A scene that isn't listed -- say one you just added in the Lutron app -- still gets a
// button: it lands in an "Other" group with a label made from its name and a generic
// pictogram, so the script never stops over a new scene. Add it to SCENE_STYLES when you
// want it to look right.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	CONNECTION_LABEL,
	MAX_LINE_CHARS,
	countOf,
	layoutGroups,
	makeId,
	validateLabels,
	writePages,
} from './page-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The scene the reference button was built for. These exact values are what the generator
// searches for in the reference button and replaces.
const REF = {
	href: '/virtualbutton/14',
	variableId: 'scene_den_medium_active',
	lines: ['Den', 'Medium'],
	icon: '💻',
}

// The rooms, in the order they appear on the pages. Hardcoded for this house: a room's
// scenes share a row, and a room is kept on one page when it fits. Scenes with no entry in
// SCENE_STYLES go in OTHER_ROOM, after all of these.
const ROOM_ORDER = ['Den', 'Downstairs', 'Living Room', 'Master Bedroom', 'Pathway', 'Whole House']
const OTHER_ROOM = 'Other'

// Shown for a scene with no entry below. A film clapper: "some scene".
const FALLBACK_ICON = '🎬'

// Scene name (exactly as on the bridge) -> [room, [line 1, line 2], pictogram]. Each
// pictogram is one to three characters from the monochrome Noto Sans Symbols fonts that
// Companion ships, which is why they take the text colour.
const SCENE_STYLES = {
	'Den Work': ['Den', ['Den', 'Work'], '🖥'], // desktop computer
	'Den Record 1': ['Den', ['Den', 'Record 1'], '🎙'], // microphone
	'Den Medium': ['Den', ['Den', 'Medium'], '💻'], // a smaller computer
	'Den Dim': ['Den', ['Den', 'Dim'], '☾'], // moon
	'Den Off': ['Den', ['Den', 'Off'], '⏻'], // power
	'Downstairs TV Mellow': ['Downstairs', ['TV', 'Mellow'], '📺'], // television
	'TV Bright': ['Downstairs', ['TV', 'Bright'], '🛋'], // couch and lamp: the TV room
	'Downstairs Off': ['Downstairs', ['Down', 'Off'], '⏻'],
	'Living Room Evening': ['Living Room', ['Living', 'Evening'], '🕯'], // candle
	'Parent Bed Time': ['Master Bedroom', ['Parent', 'Bedtime'], '🛏'], // bed
	'MBR Morning': ['Master Bedroom', ['Master', 'Morning'], '☀'], // sun
	'Mbr Off': ['Master Bedroom', ['Master', 'Off'], '⏻'],
	'Pathway Full': ['Pathway', ['Pathway', 'Full'], '↝'], // a winding path
	'Pathway Minimal': ['Pathway', ['Pathway', 'Minimal'], '↝'],
	'All Off': ['Whole House', ['All', 'Off'], '⏻'],
}

// The module publishes a scene's state as scene_<slugified name>_active. Two scenes whose
// names slugify the same get the bridge's id added to the second one's (see sceneState.ts),
// so the ids are assigned the same way here: in name order, the first keeps the plain one.
const slugify = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
function assignVariableIds(list) {
	const ids = new Map()
	const used = new Set()
	for (const scene of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
		let id = `scene_${slugify(scene.name)}_active`
		if (used.has(id)) id = `scene_${slugify(scene.name)}_${scene.href.split('/').pop()}_active`
		used.add(id)
		ids.set(scene.href, id)
	}
	return ids
}

// "Off" as a word, any case: matches "Den Off" and "Mbr Off", not "Coffee" or "Offline".
const isOffScene = (scene) => /\boff\b/i.test(scene.name)

// A label for a scene with no entry in SCENE_STYLES: its words wrapped onto two lines of
// at most MAX_LINE_CHARS characters, cut off if it doesn't fit.
function autoLines(name) {
	const lines = ['']
	for (const word of name.trim().split(/\s+/)) {
		const current = lines[lines.length - 1]
		if (current === '') lines[lines.length - 1] = word
		else if (`${current} ${word}`.length <= MAX_LINE_CHARS) lines[lines.length - 1] = `${current} ${word}`
		else if (lines.length < 2) lines.push(word)
		else lines[1] = `${lines[1]} ${word}`
	}
	return lines.map((line) => line.slice(0, MAX_LINE_CHARS))
}

const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'))
const reference = readJson('reference-scene-button.json')

const scenes = readJson('scenes.json').map((scene) => {
	const style = SCENE_STYLES[scene.name]
	if (!style) console.warn(`note: no style for "${scene.name}", using the generic one (add it to SCENE_STYLES)`)
	return {
		...scene,
		room: style ? style[0] : OTHER_ROOM,
		buttonLines: style ? style[1] : autoLines(scene.name),
		icon: style ? style[2] : FALLBACK_ICON,
	}
})

const variableIds = assignVariableIds(scenes)

// The reference button also turns its scene off on a long press and shows when it is active.
// An "off" scene has neither, so it keeps just the press that activates it: no hold groups,
// no armed look, no active feedback and no HeldNow variable.
function withoutLongPress(control) {
	const plain = structuredClone(control)
	const actions = plain.steps['0'].action_sets
	plain.steps['0'].action_sets = { down: actions.down.filter((a) => a.definitionId === 'trigger_scene'), up: [] }
	plain.steps['0'].options = { ...plain.steps['0'].options, runWhileHeld: [] }
	plain.feedbacks = []
	plain.localVariables = []
	return plain
}

// Deep-copies the reference button for one scene. Returns the new control plus how many of
// each substitution happened, so the caller can check nothing was missed.
function buildButton(scene) {
	const counts = { href: 0, label: 0, icon: 0, variable: 0 }
	const refLabel = REF.lines.join('\\n')

	function walk(node, path) {
		if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}/${i}`))
		if (node && typeof node === 'object') {
			const out = {}
			for (const [key, value] of Object.entries(node)) {
				if ((key === 'id' || key === 'overrideId' || key === '_id') && typeof value === 'string') {
					// layer ids are referenced by overrides, so keep those; regenerate entity ids
					out[key] =
						/^[A-Za-z0-9_-]{21}$/.test(value) && !isLayerId(path) ? makeId(scene.href, path, key, value) : value
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
		if (text === REF.href) {
			counts.href++
			return scene.href
		}
		if (text === refLabel) {
			counts.label++
			return scene.buttonLines.join('\\n')
		}
		if (text === REF.icon) {
			counts.icon++
			return scene.icon
		}
		const variableHits = countOf(text, REF.variableId)
		if (variableHits) {
			counts.variable += variableHits
			return text.replaceAll(REF.variableId, variableIds.get(scene.href))
		}
		return text
	}

	return { control: walk(isOffScene(scene) ? withoutLongPress(reference) : reference, ''), counts }
}

// A label that is too long can't be fixed here, but a duplicate is only cosmetic.
validateLabels(scenes, (s) => s.name, { allowDuplicates: true })
for (const [name, [, , icon]] of Object.entries(SCENE_STYLES)) {
	const length = [...icon].length
	if (length < 1 || length > 3) throw new Error(`SCENE_STYLES "${name}": pictogram must be 1-3 characters`)
}

// The rooms in ROOM_ORDER first, then anything that fell back to OTHER_ROOM. Within a room,
// scenes follow the order of SCENE_STYLES (so an "off" scene can come last); scenes with no
// entry keep the bridge's order, after the listed ones.
const styleOrder = (scene) => {
	const index = Object.keys(SCENE_STYLES).indexOf(scene.name)
	return index < 0 ? Infinity : index
}
const groups = [...ROOM_ORDER, OTHER_ROOM]
	.map((room) => ({
		name: room,
		items: scenes.filter((s) => s.room === room).sort((a, b) => styleOrder(a) - styleOrder(b)),
	}))
	.filter((g) => g.items.length > 0)

writePages({
	dir: here,
	filePrefix: 'scenes',
	pageTitle: 'Scenes',
	pages: layoutGroups(groups),
	buildControl(scene) {
		const { control, counts } = buildButton(scene)
		// The scene id is in the press that activates it and, unless it's an "off" scene, the long
		// press that turns it off; plus 1 label, 1 icon, and the active variable unless "off".
		const expected = { href: isOffScene(scene) ? 1 : 2, label: 1, icon: 1, variable: isOffScene(scene) ? 0 : 1 }
		for (const [key, want] of Object.entries(expected)) {
			if (counts[key] !== want)
				throw new Error(`${scene.name}: expected ${want} "${key}" substitutions, made ${counts[key]}`)
		}
		return control
	},
	summarize: (page) => {
		const rooms = [...new Set(page.placed.map((p) => p.group))]
		return `${page.placed.length} scenes (${rooms.map((r) => `${r} ${page.placed.filter((p) => p.group === r).length}`).join(', ')})`
	},
})
console.log(`Connection label expected on import: ${CONNECTION_LABEL}`)
