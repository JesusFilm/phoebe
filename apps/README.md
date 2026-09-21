# apps

Workspace home for the apps that ship beside the engine
([#521](https://github.com/JesusFilm/phoebe/issues/521)).

- [`console`](console) — the web console: the rail and the fleet grid an operator
  reads a relay's deployments on. Builds into `console/` at the repo root, which
  the published package carries, so `phoebe relay serve` hands the pages out of
  the one install. The desktop companion will load the same bundle from disk.

Each app is private and carries no version of its own. It reads the root
package's version at build time, so one changeset and one changelog cover the
engine and the apps together, and `changeset version` never writes a version into
a `package.json` in here.

The root `ready` gate ends in `vp run -r build`, which builds every app in this
directory. A broken app entry point is otherwise invisible until someone
packages it. Packaging itself (`vp run package`) stays out of the gate.
