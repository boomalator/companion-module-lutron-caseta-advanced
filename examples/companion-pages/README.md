# Companion page samples: lights, switches, scenes and sensors

Ready-to-import Companion pages for this module, plus the generators that made them:

- **Lights**: a button for every dimmable light (`lights-page-N.companionconfig`).
- **Switches**: a button for every switch, outdoor ones included
  (`switches-page-N.companionconfig`).
- **Scenes**: a button for every Lutron scene (`scenes-page-N.companionconfig`).
- **Sensors**: a button for every occupancy sensor (`sensors-page-N.companionconfig`).

All of them share a layout: each uses only 13 slots, to suit small surfaces and
easy testing. That is columns 0-4 of rows 0 and 1, and columns 0-2 of row 2. Row 2
columns 3 and 4 are navigation: **Page Down** (back) at 2/3 and **Page Up** (next) at
2/4. Buttons are grouped (lights by Lutron area, switches and scenes by room), each group starts on a
fresh row, and a group stays on one page when it fits.

## Light buttons

Every button has the same behaviour (Smart Step's turn-off fade is 1.5 s on both the tap
and the long press):

| Gesture                     | Action                                                 |
| --------------------------- | ------------------------------------------------------ |
| Tap (release before 250 ms) | Smart Step: if off, On (Last); if on, Nudge Up 10%     |
| Hold past 250 ms, release   | Smart Step: if off, On (Full); if on, Off (1.5 s fade) |
| Hold past 1200 ms           | Ramp Light: Start Ramp Down at 18%/s, floor 2%         |
| Release after a ramp        | Ramp Light: Stop Ramp                                  |

While the button is held between 250 and 1200 ms it turns grey and reads
"RELEASE TO TURN OFF" / "RELEASE TO TURN ON FULL", driven by a button-local
variable (`HeldNow`) that the duration groups set and reset. The gauge shows the
live level, and the dot in the corner shows which light of its room was touched
last. Timing lives in Companion's duration groups; see the header of
`src/smartControl.ts` for how the module's Smart Step and Ramp Light actions fit
them.

Labels are two lines of at most 9 characters: the room on line 1, the fixture on
line 2. A floor prefix (`Dn`, `Main`) appears only where two buttons would
otherwise read the same. With this house that gives two pages: Downstairs + Main
Floor, then Master Bedroom + Upstairs.

## Switch buttons

A switch is only ever on or off, so its button is simple: the name, an olive background
while it is on, and a press that toggles it (Smart Step: if off, On (Full); if on, Off).
Like a light's button it has a dot in the corner that shows it is the last light touched
in its room. Switches are the module's wall switches, smart switches and outdoor plug-in
switches; a switch that can't dim has no gauge or ramp. The state comes from the module's
`<area>_<name>_state` variable, which is 0 or 100.

Labels are one or two lines. With this house everything fits on one
page: Garage, then House, then Outside. Some switches control things that aren't lights:
Garage Door Power switches power to the garage door opener, so check what one does before
putting it on a surface others can reach.

## Scene buttons

Each button shows a pictogram above a two-line label (at most 9 characters a line).

| Gesture              | Action                                          |
| -------------------- | ----------------------------------------------- |
| Press                | Trigger Scene: Activate                         |
| Hold 600 ms, release | Trigger Scene: Turn Off, 0.75 s fade            |
| Hold 3 s, release    | nothing: holding that long cancels the turn-off |

Between 600 ms and 3 s the button turns white with dark olive text and icon, driven by a
button-local variable (`HeldNow`) that the duration groups set and reset, so you can see
a release will turn the scene off and let go early to cancel. While the scene is active the
button is the same olive as a lit light, using the module's `scene_<name>_active`
variable. The bridge doesn't report which scene is active, so the module works it out: a
scene is active while every light it sets is at the level it sets.

A scene whose name contains the word "off" (any case) gets a plain button instead: press
to activate, always black. There is nothing for an "off" scene to turn off or to show as
active.

The pictogram is one to three characters in a text layer, drawn with the monochrome Noto
Sans Symbols fonts that Companion ships, so it takes the text colour and needs no image
files:

| Scenes               | Pictogram                    | Characters |
| -------------------- | ---------------------------- | ---------- |
| Den Work             | desktop computer             | 🖥 U+1F5A5 |
| Den Medium           | a smaller computer           | 💻 U+1F4BB |
| Den Record           | microphone                   | 🎙 U+1F399 |
| Den Dim              | moon                         | ☾ U+263E   |
| TV Mellow            | television                   | 📺 U+1F4FA |
| TV Bright            | couch and lamp (the TV room) | 🛋 U+1F6CB |
| Living Room Evening  | candle                       | 🕯 U+1F56F |
| Parent Bed Time      | bed                          | 🛏 U+1F6CF |
| MBR Morning          | sun                          | ☀ U+2600   |
| Pathway scenes       | a winding path               | ↝ U+219D   |
| every "off" scene    | power                        | ⏻ U+23FB   |
| any scene not listed | film clapper                 | 🎬 U+1F3AC |

Use only characters those fonts cover. A character that exists only in the colour emoji
font (such as 💡) would be drawn in colour and clash with the rest.

The text size on a layer is a percentage of that layer's own height, not pixels or points,
so the same number looks twice as large on a layer half the height.

## Files

- `lights-page-N.companionconfig`, `switches-page-N.companionconfig`,
  `scenes-page-N.companionconfig`, `sensors-page-N.companionconfig`: the importable pages (JSON content; the `.companionconfig` extension is what Companion's file
  picker filters on).
- `reference-button.json`, `reference-switch-button.json`, `reference-scene-button.json`,
  `reference-sensor-button.json`: the hand-built buttons every
  other button is copied from. Edit the look or behaviour in Companion, export, and
  replace the file.
- `devices.json`: the dimmers, with their exact module variable names and the two-line
  button labels.
- `switches.json`: the switches, with their exact module variable names.
- `scenes.json`: the scenes, as the bridge reports them (name and bridge id).
- `sensors.json`: the occupancy sensors, with their exact module variable names.
- `icons/`: the pictures on the sensor buttons, as the PNGs embedded in the reference button
  (`occupied-walking.png`, `vacant-zzz.png`) and the SVGs they were drawn from.
- `generate-light-pages.mjs`, `generate-switch-pages.mjs`, `generate-scene-pages.mjs`,
  `generate-sensor-pages.mjs`: build the page files.
- `page-lib.mjs`: layout, navigation and file writing shared by the generators.

## Importing

1. Companion → Import / Export → Import, choose a file, then repeat for the rest of its
   kind. Import them in order, onto consecutive pages, so Page Up / Page Down step
   between them.
2. Map the connection in the file to your Lutron Caseta Advanced connection.
   **Its label must be `Caseta1`**: the buttons read variables such as
   `$(Caseta1:downstairs_den_window_lights_brightness)`. If yours is named
   differently, change `CONNECTION_LABEL` in `page-lib.mjs` and regenerate.
3. Import each one as a new page. Importing onto an existing page replaces everything
   on that page.

## Making these for your own house

`devices.json` holds this house's dimmers. For yours, list each dimmer's
`serial`, `area`, `name`, `deviceType`, the `variableId` shown in Companion's
Variables list for that light (`<area>_<name>_brightness`), `roomVariableSlug`
(the area, lower-cased with underscores), and `buttonLines`. Then:

```
node generate-light-pages.mjs
```

`switches.json` lists each switch's `serial`, `area`, `name`, `deviceType`, the
`variableId` shown in Companion's Variables list for it (`<area>_<name>_state`) and
`roomVariableSlug`. How each one looks (room and label) comes from `SWITCH_STYLES` in
`generate-switch-pages.mjs`, by area and name, and the rooms from `ROOM_ORDER`. A switch with
no entry still gets a button, in an "Other" group with a label made from its name. Then:

```
node generate-switch-pages.mjs
```

`scenes.json` is just each scene's `name` and bridge `href` (`/virtualbutton/N`, the id the
Trigger Scene action stores). Refresh it whenever scenes are added or renamed in the
Lutron app. How each scene looks (room, label, pictogram) comes from `SCENE_STYLES` in
`generate-scene-pages.mjs`, by scene name, and the rooms and their order from `ROOM_ORDER`;
change them to suit your house. A scene with no entry still gets a button, in an "Other"
group with a label made from its name and the generic film clapper, so the script never
stops over a new scene. Then:

```
node generate-scene-pages.mjs
```

All the generators check every label and that each button got exactly the substitutions it
should, and stop with an error otherwise. A label is at most two lines of nine characters,
and also narrow enough that Companion doesn't wrap it into a third: a line wider than its
text layer wraps, and "Spare Pwr" is only nine characters but wraps where "Driveway" does
not. The generators measure each line in Companion's default font (Arimo) at the button's
text size, so the limit follows the reference button. A duplicate label is an error for
lights and only a warning for scenes and switches.

## Don't publish a raw Companion export

A page exported straight from Companion includes the connection's configuration
and secrets, which for this module are the bridge's client certificate and
private key. The generators write a bare connection block instead. If you add
your own exports to a repo, remove the `instances` section's `config` and
`secrets` first.

`sensors.json` lists each occupancy sensor's `name` in the bridge and its `variableBase`: the
part of its variables before `_occupied` in Companion's Variables list (the Lutron area and
the sensor's name, lower-cased with underscores). How each one is labelled comes from
`SENSOR_STYLES` in `generate-sensor-pages.mjs`, by name; a sensor with no entry still gets a
button, labelled with its name. The label is one line. Then:

```
node generate-sensor-pages.mjs
```

A sensor button shows a walking figure on the olive of a lit light while the sensor is
occupied and Zzz while it is vacant, with the time spent in that state (1s to 59s, 1m to
59m, then 1:00, 1:01 and so on; blank until the module has seen the sensor change), and an
amber dot when the sensor's battery isn't Good or the bridge can't reach it. The pictures
are PNGs stored inside the button's image layers, so they travel with the page file and
need nothing from Companion's image library. The time is kept by a button-local variable
(`Secs`).
