# Why the manifest asks for `filesystem` permission

`companion/manifest.json` declares `runtime.permissions.filesystem: true`. That is unusual
for a Companion module, and it is broader than this module needs. This note records why it is
there, what was actually observed, and what is still unproven, so that anyone reviewing the
module, or hitting the same thing, does not have to work it out again.

## Summary

Without the permission, the module cannot start when it is loaded as a developer module
through a Windows **junction**. The first file read in `@companion-module/base`'s startup,
the module manifest, is denied by Node's permission sandbox. Granting `filesystem` hides the
problem by opening read and write access to everything. The module itself does not use the
filesystem. What looks like the real cause is a mismatch in how Companion builds the sandbox
grants and the module's starting path, which has not yet been shown to be avoidable by any
change on the module's side other than not using a junction.

This is my reading of the evidence below, not something confirmed with the Companion
maintainers.

## Environment

- Companion 5.0.6 (Windows 11), module loaded through its Developer modules folder
- The module is run with Companion's bundled Node `v22.23.2` (`runtime.type` is `node22`)
- The developer folder contains a junction to the repository
  (`mklink /J <dev-modules>\lutron-caseta-advanced <repository>`)
- The permission was added in commit `4bbf9e8` ("Grant filesystem permission so the module can
  actually start")

## Symptom

The connection never starts. Companion's log shows only:

```
Failed to initialize instance "Caseta1": Error: Restart forced
```

The real error is written by the module's process to stderr, which Companion logs at the
**verbose** level. Its default log level is `info`, so the error is hidden and the crash looks
silent:

```
stderr: Error: Access to this API has been restricted. Use --allow-fs-read to manage permissions.
    at open (node:internal/fs/promises:640:13)
    at Object.readFile (node:internal/fs/promises:1252:20)
    at ...\node_modules\@companion-module\base\dist\entrypoint.js:56:55
```

## What was observed

1. **With the permission removed, in a live Companion** (removed for about twelve seconds and
   then restored), the module died within a tenth of a second, on every restart, with the error
   above. Companion's command line for the process had lost `--allow-fs-read=*` and
   `--allow-fs-write=*` and kept only the module folder and Companion's resources folder.

2. **That read is the manifest.** `entrypoint.js` reads the file named by the `MODULE_MANIFEST`
   environment variable before it does anything else. In Companion's source
   (`companion/lib/Instance/ProcessManager.ts`) that variable is set to the relative path
   `companion/manifest.json`, and the process is started with `cwd` set to the module folder
   Companion found (`moduleInfo.basePath`).

3. **The grants are real paths.** `getNodeJsPermissionArguments` in
   `companion/lib/Instance/NodePath.ts` passes `--allow-fs-read=` the `realPathOrSelf(...)` of
   the module folder, with a comment that Node checks accesses against real paths, so the
   grants have to be real paths too.

4. **Reproduced outside Companion**, with Companion's own `node.exe` and the same flags, a
   child started the way Companion starts it:

   | Working directory | Grants                                                      | Result                                                                 |
   | ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
   | the junction      | module folder + Companion resources                         | denied: `Access to this API has been restricted`                       |
   | the real folder   | module folder + Companion resources                         | the manifest is read; it then stops only because it has no IPC channel |
   | the junction      | the above plus `--allow-fs-read=*` and `--allow-fs-write=*` | the manifest is read, as above                                         |

5. **The module does not need the access.** Its source has no `fs`, `path` or `os` use, and none
   of its runtime dependencies (`lutron-leap`, `tinkerhub-mdns`, `node-forge`, `async-retry`,
   `ip-address`, `uuid`) read or write files, load native addons, or start worker threads or
   child processes. `lutron-leap` can write a TLS key log, but only to a stream it is handed,
   and this module does not hand it one.

6. **`--use-system-ca` is not the cause.** The reproduction in row 2 runs with it and the narrow
   grants and starts fine.

## What this seems to mean

Companion resolves the _grants_ to real paths but starts the process, and the relative manifest
path, from the _unresolved_ folder. On Windows a junction path is not canonicalised by Node's
permission check, so a read that goes through the junction falls outside a grant for the real
folder. A symbolic link may behave differently, since Companion's comments describe the symlink
case; that has not been tried here.

A possible change on Companion's side: start the process with `cwd` set to the same
`realPathOrSelf(moduleDir)` it uses for the grants.

## What is not established

- That a layout with **no junction** (the repository cloned straight under the developer
  folder, or the developer path pointed at the folder that contains it) starts without the
  permission in a live Companion. The reproduction says it should. It has not been tried.
- That a true symbolic link works. Not tried (it needs administrator rights or Developer Mode
  on Windows).
- Whether a module installed from a package, rather than loaded through the developer folder,
  has the problem. It would not go through a junction, so it probably does not, but that has
  not been tried either.

## How to settle it

1. Remove the `permissions` block from `companion/manifest.json`.
2. Load the module from a folder that is a real directory under the developer path, with no
   junction or link in between.
3. Watch Companion's log at the verbose level. If the module starts, the permission is not
   needed for that layout and can be removed from the manifest. If it fails, the log gives the
   path that was denied.

Do not do step 1 against a junction layout: it is the failure described above.

## Cost of leaving it as it is

The permission is part of the manifest, so it applies to everyone who installs the module, not
only to developers: the process is started with read and write access to the whole filesystem.
The module does nothing with it, but a reviewer is right to question it.
