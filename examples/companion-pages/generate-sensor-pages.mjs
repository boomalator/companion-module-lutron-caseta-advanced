// Builds importable Companion page files (one button per occupancy sensor) from a single
// hand-built reference button and a list of sensors.
//
//   node generate-sensor-pages.mjs
//
// Reads  reference-sensor-button.json  (the Stairs sensor's button) and sensors.json.
// Writes sensors-page-N.companionconfig.
//
// A sensor button shows a walking figure on the olive of a lit light while the sensor is
// occupied, and Zzz on black while it is vacant, with the sensor's name and how long it has
// been in that state (1s ... 59s, 1m ... 59m, then 1:00, 1:01 ...; blank until the module has
// seen the sensor change). A small amber dot in the corner shows the bridge reports a problem
// with the sensor: its battery isn't Good, or it isn't Available. The two pictures are PNG
// images inside the button's own image layers (they do not use Companion's image library);
// the PNGs and the SVGs they came from are in icons/. Nothing is pressed on a sensor
// button, so it has no actions.
//
// Everything about the reference button is copied as-is; only the module variable name
// (<base>_occupied, _last_true, _last_false, _battery, _availability) and the label are
// rewritten for each sensor.
//
// How a sensor looks (its label) comes from SENSOR_STYLES below, by the sensor's name in the
// bridge. A sensor that isn't listed still gets a button, with its name as the label, and the
// script stops only if that name is too long for the button.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	CONNECTION_LABEL,
	countOf,
	layoutGroups,
	lineLimitEm,
	makeId,
	textWidthEm,
	validateLabels,
	writePages,
} from './page-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The sensor the reference button was built for. These exact values are what the generator
// searches for in the reference button and replaces.
const REF = {
	variableBase: 'motion_stairs',
	lines: ['Stairs'],
}

// "<sensor name in the bridge>" -> [label]. One line: the label is bottom-aligned above the time.
// Sensors follow this order.
const SENSOR_STYLES = {
	'Motion Downstairs': ['Downstairs'],
	'Motion Stairs': ['Stairs'],
	'Laundry motion': ['Laundry'],
	'Garage Sensor': ['Garage'],
}

const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'))
const reference = readJson('reference-sensor-button.json')
// How much text fits on the label line. The formula the other generators use (lineLimitEm)
// gives 4.44 em for this layer (4.66 with the tolerance), but "Downstairs", 4.95 em wide, was
// seen to fit on one line in Companion at this size. So the limit here is taken from that
// observation rather than the formula; the cause of the difference hasn't been found.
const formulaLimitEm = lineLimitEm(reference.style.layers.find((l) => l.id === 'text0'))
const labelLimitEm = Math.max(formulaLimitEm, textWidthEm('Downstairs') / 1.05)

const sensors = readJson('sensors.json').map((sensor) => {
	const style = SENSOR_STYLES[sensor.name]
	if (!style) console.warn(`note: no style for "${sensor.name}", using its name (add it to SENSOR_STYLES)`)
	return { ...sensor, buttonLines: style ?? [sensor.name] }
})

// Deep-copies the reference button for one sensor. Returns the new control plus how many of
// each substitution happened, so the caller can check nothing was missed.
function buildButton(sensor) {
	const counts = { variable: 0, label: 0 }
	const refLabel = REF.lines.join('\\n')

	function walk(node, path) {
		if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}/${i}`))
		if (node && typeof node === 'object') {
			const out = {}
			for (const [key, value] of Object.entries(node)) {
				if ((key === 'id' || key === 'overrideId' || key === '_id') && typeof value === 'string') {
					// layer ids are referenced by overrides, so keep those; regenerate entity ids
					out[key] =
						/^[A-Za-z0-9_-]{21}$/.test(value) && !isLayerId(path)
							? makeId(sensor.variableBase, path, key, value)
							: value
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
			result = sensor.buttonLines.join('\\n')
		}
		const variableHits = countOf(result, `${CONNECTION_LABEL}:${REF.variableBase}_`)
		if (variableHits) {
			result = result.replaceAll(
				`${CONNECTION_LABEL}:${REF.variableBase}_`,
				`${CONNECTION_LABEL}:${sensor.variableBase}_`,
			)
			counts.variable += variableHits
		}
		return result
	}

	return { control: walk(reference, ''), counts }
}

// The label is one line, as wide as the layer allows ("Downstairs" is the longest so far)
// Sensors follow the order of SENSOR_STYLES; ones with no entry come last, in the order of sensors.json
const styleOrder = (sensor) => {
	const index = Object.keys(SENSOR_STYLES).indexOf(sensor.name)
	return index < 0 ? Infinity : index
}
sensors.sort((a, b) => styleOrder(a) - styleOrder(b))

validateLabels(sensors, (s) => s.name, {
	allowDuplicates: true,
	limitEm: labelLimitEm,
	maxLines: 1,
	maxChars: Infinity,
})

writePages({
	dir: here,
	filePrefix: 'sensors',
	pageTitle: 'Sensors',
	pages: layoutGroups([{ name: 'Sensors', items: sensors }]),
	buildControl(sensor) {
		const { control, counts } = buildButton(sensor)
		// the seconds variable reads _last_true and _last_false twice each (4); the occupied and
		// vacant feedbacks read _occupied (2); the warning reads _battery and _availability (2); and 1 label
		const expected = { variable: 8, label: 1 }
		for (const [key, want] of Object.entries(expected)) {
			if (counts[key] !== want)
				throw new Error(`${sensor.name}: expected ${want} "${key}" substitutions, made ${counts[key]}`)
		}
		return control
	},
	summarize: (page) => `${page.placed.length} sensors`,
})
console.log(`Connection label expected on import: ${CONNECTION_LABEL}`)
