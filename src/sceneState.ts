import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import type { DeviceDefinition } from 'lutron-leap'
import type { ModuleInstance } from './main.js'
import { getDeviceLevelType, slugify } from './deviceTypes.js'
import { sendLevel } from './levelControl.js'

// The bridge has no "is this scene active" state -- confirmed live: /virtualbutton/N/status
// answers "This request is not supported", and pressing a scene is a momentary event. What
// it does expose is what a scene *sets*: each scene's programming model points at a preset,
// and the preset lists (zone, level) assignments. So a scene is treated as active while
// every zone it sets is at the level it sets -- the same thing the Lutron app shows after
// you press it, and it stops being active as soon as you change one of its lights.

// Dimmers report whole-percent levels and a fade can land a point off; a point of slack
// keeps a scene from flickering inactive over rounding.
const LEVEL_TOLERANCE = 1

export interface SceneAssignment {
	zoneHref: string
	level: number
}

interface ProgrammingModelBody {
	ProgrammingModel?: { Preset?: { href: string } }
}
interface PresetBody {
	Preset?: { PresetAssignments?: Array<{ href: string }> }
}
interface PresetAssignmentBody {
	PresetAssignment?: { AffectedZone?: { href: string }; Level?: number }
}

// Reads every programmed scene's assignments. This is a few dozen to a couple hundred
// round trips, so it runs after scenes themselves are loaded and never blocks them.
export async function LoadSceneAssignments(self: ModuleInstance): Promise<void> {
	const bridge = self.bridge
	if (!bridge) return

	const assignmentsByScene: Record<string, SceneAssignment[]> = {}

	for (const scene of Object.values(self.scenes)) {
		try {
			const pm = (await bridge.client.request('ReadRequest', scene.ProgrammingModel.href))
				.Body as unknown as ProgrammingModelBody
			const presetHref = pm?.ProgrammingModel?.Preset?.href
			if (!presetHref) continue

			const preset = (await bridge.client.request('ReadRequest', presetHref)).Body as unknown as PresetBody
			const refs = preset?.Preset?.PresetAssignments ?? []

			// /presetassignment/N covers dimmed and switched assignments alike (reading the
			// typed /dimmedlevelassignment and /switchedlevelassignment paths directly is
			// unreliable: the latter never answers).
			const assignments = await Promise.all(
				refs.map(async (ref) => {
					const body = (await bridge.client.request('ReadRequest', ref.href)).Body as unknown as PresetAssignmentBody
					const pa = body?.PresetAssignment
					if (!pa?.AffectedZone?.href || typeof pa.Level !== 'number') return undefined
					return { zoneHref: pa.AffectedZone.href, level: pa.Level }
				}),
			)
			assignmentsByScene[scene.href] = assignments.filter((a) => a !== undefined)
		} catch (err) {
			self.log('warn', `Failed to read assignments for scene ${scene.Name}: ${(err as Error).message}`)
		}
	}

	self.sceneAssignments = assignmentsByScene
	self.log(
		'info',
		`Loaded settings for ${Object.keys(assignmentsByScene).length} scenes (${Object.values(assignmentsByScene).reduce((n, a) => n + a.length, 0)} light levels)`,
	)
}

// Picos, occupancy sensors and the bridge itself are in devicesOnBridge too, and have no
// LocalZones at all -- so the lookup has to tolerate that.
export function deviceForZone(self: ModuleInstance, zoneHref: string): DeviceDefinition | undefined {
	return self.devicesOnBridge.find((device) => device.LocalZones?.[0]?.href === zoneHref)
}

// Active when every light the scene sets is at its level. A scene's assignment that points
// at something this module doesn't track a level for (a fan, shades, a zone outside the
// device list) is skipped rather than counted against it, but a scene with nothing
// checkable is never reported active.
function isSceneActive(self: ModuleInstance, sceneHref: string): boolean {
	const assignments = self.sceneAssignments[sceneHref]
	if (!assignments || assignments.length === 0) return false

	let checked = 0
	for (const { zoneHref, level } of assignments) {
		const device = deviceForZone(self, zoneHref)
		if (!device) continue
		const current = self.currentLevel[device.SerialNumber]
		if (current === undefined) continue
		checked++
		if (Math.abs(current - level) > LEVEL_TOLERANCE) return false
	}
	return checked > 0
}

export function BuildSceneVariableDefinitions(self: ModuleInstance): CompanionVariableDefinition[] {
	const scenes = Object.values(self.scenes).sort((a, b) => a.Name.localeCompare(b.Name))
	const used = new Set<string>()
	const variables: CompanionVariableDefinition[] = []

	self.sceneVariableIds = {}
	for (const scene of scenes) {
		let variableId = `scene_${slugify(scene.Name)}_active`
		if (used.has(variableId)) {
			// two scenes with the same name -- disambiguate with the bridge's id for each
			variableId = `scene_${slugify(scene.Name)}_${scene.href.split('/').pop()}_active`
		}
		used.add(variableId)
		self.sceneVariableIds[scene.href] = variableId
		variables.push({ variableId, name: `Scene Active: ${scene.Name}` })
	}
	return variables
}

export function SeedSceneVariableValues(self: ModuleInstance): void {
	const values: CompanionVariableValues = {}
	for (const [sceneHref, variableId] of Object.entries(self.sceneVariableIds)) {
		const active = isSceneActive(self, sceneHref)
		self.sceneActive[sceneHref] = active
		values[variableId] = active ? 1 : 0
	}
	self.setVariableValues(values)
}

// Called whenever a light's level changes: re-checks only the scenes that include that
// light, and only pushes a variable update when a scene's state actually flips.
export function RefreshSceneActive(self: ModuleInstance, device: DeviceDefinition): void {
	const zoneHref = device.LocalZones?.[0]?.href
	if (!zoneHref) return

	const values: CompanionVariableValues = {}
	for (const [sceneHref, assignments] of Object.entries(self.sceneAssignments)) {
		if (!assignments.some((a) => a.zoneHref === zoneHref)) continue
		const variableId = self.sceneVariableIds[sceneHref]
		if (!variableId) continue

		const active = isSceneActive(self, sceneHref)
		if (self.sceneActive[sceneHref] === active) continue
		self.sceneActive[sceneHref] = active
		values[variableId] = active ? 1 : 0
	}
	if (Object.keys(values).length > 0) self.setVariableValues(values)
}

// Sets every light the scene controls to off. A scene has no "off" of its own, so this is
// the other half of "activate": it uses the scene's own list of lights (read on load and
// rescan, not on every press) and sends each of them 0. Lights it shares with another
// scene go off too, which makes that scene inactive -- the same as switching them off by
// hand. Zones the module doesn't track a level for (fans, shades) are left alone.
//
// The bridge works through level commands one after another (about 6 a second), so the
// last light to be told can start fading a second or more after the first. Two things
// keep that short: lights already known to be off are skipped, and the rest are sent
// brightest first, so the change you notice most starts soonest.
export async function TurnSceneOff(self: ModuleInstance, sceneHref: string, fadeSeconds: number): Promise<void> {
	const assignments = self.sceneAssignments[sceneHref]
	if (!assignments) {
		self.log('warn', 'Scene settings are not loaded yet, so the scene cannot be turned off')
		return
	}

	const targets = new Map<string, DeviceDefinition>()
	for (const { zoneHref } of assignments) {
		const device = deviceForZone(self, zoneHref)
		if (device && getDeviceLevelType(device)) targets.set(device.SerialNumber, device)
	}

	// A light with no reading yet is treated as fully on, so it goes first rather than last.
	const levelOf = (device: DeviceDefinition): number => self.currentLevel[device.SerialNumber] ?? 100
	const ordered = [...targets.values()].filter((device) => levelOf(device) > 0).sort((a, b) => levelOf(b) - levelOf(a))

	await Promise.all(
		ordered.map(async (device) =>
			sendLevel(self, device, 0, getDeviceLevelType(device) === 'dimmer' ? fadeSeconds : 0),
		),
	)
}
