# apps

Workspace home for the apps that ship beside the engine
([#521](https://github.com/JesusFilm/phoebe/issues/521)).

- [`console`](console) — the console: the rail and the pages an operator reads
  their installs on. Builds into `console/` at the repo root, which the companion
  beside it loads from disk.

- [`desktop`](desktop) — the companion: an Electron main and preload whose
  window loads the `console` bundle from disk over a privileged custom scheme. It
  has no UI of its own.

Each app is private and carries no version of its own. It reads the root
package's version at build time, so one changeset and one changelog cover the
engine and the apps together, and `changeset version` never writes a version into
a `package.json` in here.

The root `ready` gate ends in `vp run -r build`, which builds every app in this
directory. A broken app entry point is otherwise invisible until someone
packages it. Packaging itself (`vp run package`) stays out of the gate.
