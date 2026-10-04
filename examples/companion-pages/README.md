# Companion page samples: lights and scenes

Ready-to-import Companion pages for this module, plus the generators that made them:

- **Lights**: a button for every dimmable light (`lights-page-N.companionconfig`).
- **Scenes**: a button for every Lutron scene (`scenes-page-N.companionconfig`).

Both kinds of page share a layout: each uses only 13 slots, to suit small surfaces and
easy testing. That is columns 0-4 of rows 0 and 1, and columns 0-2 of row 2. Row 2
columns 3 and 4 are navigation: **Page Down** (back) at 2/3 and **Page Up** (next) at
2/4. Buttons are grouped (lights by Lutron area, scenes by room), each group starts on a
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

- `lights-page-1.companionconfig`, `lights-page-2.companionconfig`,
  `scenes-page-1.companionconfig`, `scenes-page-2.companionconfig`: the importable
  pages (JSON content; the `.companionconfig` extension is what Companion's file
  picker filters on).
- `reference-button.json`, `reference-scene-button.json`: the hand-built buttons every
  other button is copied from. Edit the look or behaviour in Companion, export, and
  replace the file.
- `devices.json`: the dimmers, with their exact module variable names and the two-line
  button labels.
- `scenes.json`: the scenes, as the bridge reports them (name and bridge id).
- `generate-light-pages.mjs`, `generate-scene-pages.mjs`: build the page files.
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

Both generators check every label (at most two lines of nine characters) and that each
button got exactly the substitutions it should, and stop with an error otherwise. A
duplicate label is an error for lights and only a warning for scenes.

## Don't publish a raw Companion export

A page exported straight from Companion includes the connection's configuration
and secrets, which for this module are the bridge's client certificate and
private key. The generators write a bare connection block instead. If you add
your own exports to a repo, remove the `instances` section's `config` and
`secrets` first.
