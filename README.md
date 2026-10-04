# companion-module-lutron-caseta-advanced

An extended fork of [companion-module-lutron-caseta](https://github.com/bitfocus/companion-module-lutron-caseta) by Bear Cherian, with additional functionality, tested against a Lutron Caseta Smart Bridge Pro. This fork carries breaking changes and is not intended to be merged back upstream.

This extended fork is maintained by B P Hynes. Licensed MIT — see [LICENSE](./LICENSE).

See [HELP.md](./companion/HELP.md) for using the module, and [DEVELOPING.md](./DEVELOPING.md) for building it from source and loading it into Companion as a developer module.

## Getting started

Executing a `yarn` command should perform all necessary steps to develop the module, if it does not then follow the steps below.

The module can be built once with `yarn build`. This should be enough to get the module to be loadable by companion.

While developing the module, by using `yarn dev` the compiler will be run in watch mode to recompile the files on change.
