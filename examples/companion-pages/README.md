# Companion page samples: one button per dimmer

Ready-to-import Companion pages with a button for every dimmable light, plus the
generator that made them. Every button has the same behaviour (Smart Step's turn-off
fade is 1.5 s on both the tap and the long press):

| Gesture                     | Action                                                 |
| --------------------------- | ------------------------------------------------------ |
| Tap (release before 250 ms) | Smart Step: if off, On (Last); if on, Nudge Up 10%     |
| Hold past 250 ms, release   | Smart Step: if off, On (Full); if on, Off (1.5 s fade) |
| Hold past 1200 ms           | Ramp Light: Ramp Down at 18%/s, floor 2%               |
| Release after a ramp        | Ramp Light: Stop Ramp                                  |

While the button is held between 250 and 1200 ms it turns grey and reads
"RELEASE TO TURN OFF" / "RELEASE TO TURN ON FULL", driven by a button-local
variable (`HeldNow`) that the duration groups set and reset. The gauge shows the
live level, and the dot in the corner shows which light of its room was touched
last. Timing lives in Companion's duration groups; see the header of
`src/smartControl.ts` for how the module's Smart Step and Ramp Light actions fit
them.

## Files

- `lights-page-1.companionconfig`, `lights-page-2.companionconfig`: the importable
  pages (JSON content; the `.companionconfig` extension is what Companion's file
  picker filters on).
- `reference-button.json`: the hand-built button every other button is copied
  from. Edit the look or behaviour in Companion, export, and replace this file.
- `devices.json`: the dimmers, with their exact module variable names and the
  two-line button labels.
- `generate-light-pages.mjs`: builds the page files.

## Importing

1. Companion → Import / Export → Import, choose `lights-page-1.companionconfig`, then
   repeat for `lights-page-2.companionconfig`. Import them in order, onto
   consecutive pages, so Page Up / Page Down step between them.
2. Map the connection in the file to your Lutron Caseta Advanced connection.
   **Its label must be `Caseta1`**: the buttons read variables such as
   `$(Caseta1:downstairs_den_window_lights_brightness)`. If yours is named
   differently, change `CONNECTION_LABEL` in the generator and regenerate.
3. Import each one as a new page. Importing onto an existing page replaces everything
   on that page.

## Layout and labels

Each page uses only 13 slots, to suit small surfaces and easy testing: columns 0-4
of rows 0 and 1, and columns 0-2 of row 2. Row 2 columns 3 and 4 are navigation:
**Page Down** (back) at 2/3 and **Page Up** (next) at 2/4.

Lights are grouped by Lutron area. Each area starts on a fresh row and stays on one
page when it fits; an area larger than a page is split across pages. With this
house that gives two pages: Downstairs + Main Floor, then Master Bedroom + Upstairs.

Labels are two lines of at most 9 characters: the room on line 1, the fixture on
line 2. A floor prefix (`Dn`, `Main`) appears only where two buttons would
otherwise read the same.

## Making these for your own house

`devices.json` holds this house's dimmers. For yours, list each dimmer's
`serial`, `area`, `name`, `deviceType`, the `variableId` shown in Companion's
Variables list for that light (`<area>_<name>_brightness`), `roomVariableSlug`
(the area, lower-cased with underscores), and `buttonLines`. Then:

```
node generate-light-pages.mjs
```

The generator checks every label (length, uniqueness) and that each button got
exactly the substitutions it should, and stops with an error otherwise.

## Don't publish a raw Companion export

A page exported straight from Companion includes the connection's configuration
and secrets, which for this module are the bridge's client certificate and
private key. The generator writes a bare connection block instead. If you add
your own exports to a repo, remove the `instances` section's `config` and
`secrets` first.
