# Installing the development version into Companion

How to build this module from source and load it into Bitfocus Companion as a developer
module, so it runs straight from the repository and restarts when you change a file. Written
and checked on Windows with Companion 5.0; the macOS and Linux notes are untested.

For what the module does and how to use it, see [companion/HELP.md](./companion/HELP.md).

## What you need

| Requirement     | Version                   | Why                                                                                                                                                                |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Companion       | 5.x (checked on 5.0.6)    | Loads the module. Its Developer option is what makes a module in your own folder show up.                                                                          |
| Node.js         | 22.20 or newer (`^22.20`) | Builds the module, runs the lint and the test scripts. Companion runs the module itself with its own bundled Node 22, so this only has to be good enough to build. |
| Yarn            | 4.x (`yarn@4.10.3`)       | The scripts use Yarn's `run` command, so `npm run build` fails with `'run' is not recognized`. Get it through Corepack, which ships with Node.                     |
| Git             | any                       | To clone, and for the pre-commit hook (lint and format).                                                                                                           |
| A Lutron bridge | Smart Bridge Pro (tested) | The module talks to the bridge over the LAN. Pairing needs physical access to the bridge.                                                                          |

The bridge and the machine running Companion must be on the same network, and Companion's
machine needs to be able to reach the bridge on TCP 8081 (the control connection) and 8083
(pairing), and to see its mDNS announcements (UDP 5353) if you want it to appear in the
discovery list. You can also type the bridge's IP address in by hand.

## Install

1. **Get Yarn.** Once per machine:

   ```
   corepack enable
   ```

   Node's installer puts it in a protected folder on some systems; if that fails with a
   permissions error, run it once from an administrator terminal. After that, `yarn --version`
   should print `4.10.3` inside the repo (Corepack reads the exact version from `package.json`).

2. **Clone and install.**

   ```
   git clone https://github.com/boomalator/companion-module-lutron-caseta-advanced.git
   cd companion-module-lutron-caseta-advanced
   yarn install
   ```

   `.yarnrc.yml` turns install scripts off and refuses packages published in the last three
   days. The module runs from this folder, so `node_modules` has to stay where it is: it is
   not bundled.

   Install scripts being off also means the pre-commit hook (lint and format on staged files)
   is not set up for you. If you plan to commit, install it once with `yarn husky`.

3. **Build.**

   ```
   yarn build
   ```

   This compiles `src/` into `dist/`, which is what `companion/manifest.json` points
   Companion at (`../dist/main.js`). `dist/` is not in git, so a fresh clone must build once.

   `yarn build` first deletes `dist/`. If Companion is already running the module, use
   `yarn dev` (or `npx tsc -p tsconfig.build.json`) instead: they compile in place, so the
   module is never left without its files.

4. **Make the folder visible to Companion.** Companion looks for developer modules in one
   folder, with each module in a subfolder holding a `companion/manifest.json`. Either clone
   the repo straight into that folder, or keep it where you like and link it in. A junction
   needs no administrator rights on Windows, where a symbolic link would:

   ```
   mkdir D:\CompanionDevModules
   mklink /J D:\CompanionDevModules\lutron-caseta-advanced D:\Gits\companion-module-lutron-caseta-advanced
   ```

   (Use `cmd`, not PowerShell, for `mklink`. On macOS or Linux, `ln -s` the repo into the
   folder.) The paths are examples; use your own.

5. **Turn on developer modules in Companion.** In Companion's settings window (opened from
   the launcher window), open the **Developer** section, enable developer modules, and set the
   path to the folder from step 4 (`D:\CompanionDevModules` in the example). Companion saves it
   as `enable_developer` and `dev_modules_path` in the `config.json` in its configuration
   folder. Restart Companion if it asks to.

6. **Add the connection.** In Companion's **Connections** page, add a connection and search for
   **Lutron Caseta Advanced**; the developer copy is listed with version `dev`. Give the
   connection a label. The example pages in [examples/companion-pages](./examples/companion-pages)
   expect `Caseta1`.

7. **Pair with the bridge.** In the connection's settings pick your bridge from the Host
   dropdown, or type its IP address, and save. Then press the small black pairing button on the
   bridge within about 30 seconds. The module keeps the certificate it is issued in the
   connection's secrets; you only pair once. When it works the connection goes green and the
   module's variables, such as `$(Caseta1:...)`, appear in the Variables list.

## Day to day

- Run `yarn dev` in a terminal. It recompiles on every save.
- Companion watches the module folder and **restarts the connection whenever any file in it
  changes**, not just `dist/`: source, docs, generated example pages, even a formatter touching
  a file. The connection then reconnects to the bridge and rebuilds its variables, which takes
  a few seconds, and scene variables take longer (around half a minute) because the module
  reads what each scene sets. Anything you check in that window (a variable, the HTTP API) can
  briefly report "not found". Wait for the connection to come back before deciding something
  broke.
- If the connection keeps restarting, it is crashing on start. The reason is in Companion's
  **Log** page: look for a stack trace next to "Starting instance".
- A quick check from outside Companion that a variable exists, using its HTTP API:

  ```
  curl http://127.0.0.1:8000/api/variable/Caseta1/stairs_stair_lights_state/value
  ```

  The reply is `404` for a variable that does not exist. Replace `Caseta1` with your
  connection's label and `8000` with Companion's HTTP port.

- Before committing: `yarn lint` and `yarn format`. A pre-commit hook runs the linter and
  Prettier on the staged files.

## File permissions and how Companion starts the module

Nothing here needs administrator rights, and Companion should not be run as one.

- **Your account** needs read access to the repository (including `node_modules` and
  `dist/`) and to the junction or link. The default permissions on a normal drive are enough.
- **Companion starts the module with Node's permission model.** The command line it uses, as
  seen in its log, is:

  ```
  node.exe --use-system-ca --no-warnings=SecurityWarning --permission
    --allow-fs-read=<module folder> --allow-fs-read=<Companion resources folder>
    --allow-fs-read=* --allow-fs-write=*  <module folder>\dist\main.js
  ```

  The module is only allowed to read its own folder and Companion's resources, unless the
  manifest asks for more. `companion/manifest.json` sets `runtime.permissions.filesystem` to
  `true`, which is what adds the read and write access to everything (`*`). If you set it to
  `false`, the module can only read its own folder, so it must not need to write or read
  anywhere else.

  ### Why this module asks for it

  The full write-up, with the evidence and what is still unproven, is in
  [notes/filesystem-permission.md](./notes/filesystem-permission.md).

  The module's own code does not touch the filesystem, and neither does anything in its
  runtime dependencies (no file reads or writes, native addons, worker threads or child
  processes), so it does not need the access for anything it does. It needs it to get started
  at all, in the way it is loaded during development on Windows.

  Without the permission, Companion 5.0.6 starts the module with only the narrow grants above
  and it dies at once. The log (at the verbose level, which Companion's log hides by default,
  so the crash looks silent) shows:

  ```
  stderr: Error: Access to this API has been restricted. Use --allow-fs-read to manage permissions.
      at open (node:internal/fs/promises:640:13)
      at Object.readFile (node:internal/fs/promises:1252:20)
      at ...\node_modules\@companion-module\base\dist\entrypoint.js:56:55
  ```

  followed by Companion's generic "Failed to initialize instance: Restart forced". That read
  is the first thing `@companion-module/base` does on startup: it reads the module's manifest
  from the path in the `MODULE_MANIFEST` environment variable, which Companion sets to the
  relative path `companion/manifest.json` while starting the process in the module folder it
  found. The grants are given as real paths, because Node checks accesses against real paths.

  In a development setup where the folder Companion found is a Windows junction to the real
  repository, that relative read goes through the junction, and Node does not treat a junction
  path as inside a grant for the real folder. Reproduced outside Companion with its bundled
  Node 22 and the same flags: from the junction the read is denied, from the real folder it is
  allowed, and with `--allow-fs-read=*` it is allowed either way. The loading of the module's
  own code is not affected, only this read, but that is enough to stop it before any of its
  code runs. The permission was added in commit `4bbf9e8` for exactly this crash.

  What has not been established: whether a layout with no junction (the repository cloned
  straight under the developer folder, or the developer path pointed at the folder that
  contains it) starts without the permission in a live Companion. The reproduction says it
  should, and a true symbolic link has not been tried. If you try it and it works, the
  permission can come out of `companion/manifest.json`. Until then it stays, because without
  it the module may not start. It would also be worth reporting to Companion: it passes the
  grants through `realpath` but starts the process and the manifest path from the unresolved
  folder, which is the mismatch here.

- **The Node that runs the module is Companion's own**, from its `node-runtimes\node22`
  folder, selected by `runtime.type` (`node22`) in the manifest. That is why the system Node
  only has to be able to build. On Windows, allow that `node.exe` through the firewall on a
  private network when prompted; Companion's installer normally adds inbound rules for it,
  which discovery needs.

## Building a package instead

To install the module the ordinary way, without the developer folder, `yarn package` builds
and then runs `companion-module-build`, which makes a module package that Companion can
import on its Modules page (`.gitignore` already ignores a `.tgz` or `pkg` folder in the
repository root). This route has not been checked for this repository. Do not run it while a
developer copy is connected to Companion: it rebuilds `dist/`, which restarts the module.

## If something goes wrong

| What you see                                             | Check                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The module is not in the Add connection list             | Developer modules are on and the path is right; the subfolder holds `companion/manifest.json`; the junction still points at the repo. |
| The connection will not start, or restarts over and over | `dist/main.js` exists (run the build), `node_modules` is installed, and the Log page for a stack trace.                               |
| `'run' is not recognized`                                | You used `npm run`. Use `yarn`.                                                                                                       |
| `yarn` is not found, or reports the wrong version        | `corepack enable`, then open a new terminal.                                                                                          |
| "Not found" or empty variables straight after a change   | The connection is still restarting. Wait for it to come back.                                                                         |
| The bridge is not in the Host list                       | mDNS discovery was blocked by a firewall or a different network or VLAN. Type the bridge's IP address in instead.                     |
| Pairing times out                                        | Press the black button on the bridge within 30 seconds of saving, and make sure TCP 8083 is reachable.                                |
