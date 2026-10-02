# The console

Phoebe runs unattended, which is the point of it and also the problem. A
container that needs no babysitting gives you nothing to look at, and the two
questions an operator has are "is it alive" and "why did that unit fail". Until
now the honest answer was to open a shell and read `phoebe status`.

The **console** is the same answer in a window. It shows every Phoebe install on
your machine, what each one is doing right now, and the settings each one
resolved. The **companion**, a desktop app, is what opens it.

Two pieces, and you can stop after the first:

| Piece           | What it is                                                                 | You need it when                                   |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| `phoebe status` | The deployment report, read on the host. No network, no sign-in.           | You have a shell on the machine.                   |
| The companion   | A desktop app. The console window over the local installs on this machine. | You run Phoebe on your laptop, or you want alerts. |

Config fields are in [`configuration.md`](configuration.md). Labels, drafts and
watermarks are in [`operating.md`](operating.md). The words are in
[`CONTEXT.md`](../CONTEXT.md).

## The companion

A **local install** is a repository folder on this machine that the companion
drives through Docker Compose. You point it at a folder, and an **install** tab
runs the host verbs in place with their output streaming into the window: `init`,
`start`, `stop`, `upgrade --check` and `doctor`. Docker is checked, never
installed.

A folder that is already a workspace's tenant is not offered `init` over the
top of its config. It is offered a deployment of its own beside the tenant: the
scaffold goes into `.phoebe/` under the folder with the tenant's settings
carried over, and the tenant entry points the workspace at that folder for its
`.env` and prompts, so the two share one set. The folder stays a tenant.

The companion adds no listener to the deployment container. Main spawns
`docker compose` exactly as you would at a shell, and reads through
`compose exec`. An install has three states: running, stopped and not
initialised. Compose answers directly, so there is nothing to infer from silence.

A **rail** runs down the left with every install on it, always, whatever page you
are on, because "is everything alive" is the question this thing exists to
answer. A workspace opens out to its children, and each child's gear opens that
tenant's own config. A child's row says whether it is working, whether it is
switched on, and how many errors and warnings it has, each named on hover; the
workspace's own line sums them, so a closed workspace still shows that
something under it needs a look. One of those errors the companion finds
itself, on the host: a tenant `.env` the container's unprivileged user cannot
read. The tenant's page opens on it with a button that grants that user read
access to the one file.

The console's header names each pipeline with a unit in flight and the work it
is on, and counts the install's errors and warnings; pressing the counts lists
them. A pipeline's tab pulses while it is working and carries its own counts.

With **Check for updates automatically** on (Settings → Updates), the companion
reads every install shortly after launch and every six hours, and floats one
line over the foot of the page when any is behind: "Update available for …", with
**Update**, a list behind the title, and a dismiss that is remembered for that
set of versions. It never updates by itself. **Update** moves each harness pin
and, on a running install, puts the new version into the container beside the
old one, so a unit in flight finishes on what it started with.

The install tab's **Phoebe** section lists the launcher (`phoebe-agent`, pinned
in `container/Dockerfile`) and the engine (`engine.ref` in the config), each
with a field and a button that runs `upgrade` for that half.

The install tab's **AI harness** section lists the agent CLIs the container
carries (Cursor's `agent`, Claude Code, Codex): the version
`container/Dockerfile` pins, the one the running container has, and, after
**Check for updates**, the newest published. Each row can pin a version in the
Dockerfile, and **Rebuild and restart** puts it in the container. A tenant's
page shows the same for the one harness its provider runs. The container is the
workspace's, so the pin it moves is shared by every tenant.

## What the console shows

The console is one React bundle in `apps/console`, which the companion loads from
disk.

Selecting an install opens its container's output. The gear beside it opens the
install's own page: the install tab, and five more.

| Tab           | What it answers                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**  | The engine ref and running SHA, reconcile state, slots, every pipeline's two lines, held tenants.                                     |
| **Pipelines** | One row per pipeline: the process line, the state line, units in flight against their budgets, the wedged clause.                     |
| **Doctor**    | The last run's checks with the trigger that produced them and how long ago.                                                           |
| **Secrets**   | Which keys each tenant reads, whether each is set, and where the value came from. Never a value.                                      |
| **Config**    | Each config as a form, the file one press behind it: the deployment's few settings on a workspace root, a tenant's own on each child. |

Two things write, and both write to this machine. Each row of the config form
saves itself, as one `{ path, value }` patch against the fingerprint its page was drawn from, and the
answer is `written` or `refused`, a refusal always carrying the exact manual
edit. The secret form hands the value to the running container's tenant store,
or to the deployment `.env` when nothing is running.

A stopped install shows its config, read from the file, and nothing else. The
window may still be holding the last report it read, and it does not draw it: a
report with an age on it beside a container that is down is two facts that
contradict each other.

Everything on the five tabs is a rendering of `state/deployment.json`, which the
deployment wrote. Derivation happens in the deployment, once. `phoebe status`
reads the same file on the host and reaches the same verdicts, which is what
stops the two from disagreeing about a wedged pipeline. A report whose schema
the console does not know is not read at all. Guessing would be worse than a
blank tab.

## Alerting

Nobody watches a window. The companion raises one notification when an install
crosses into one of three conditions, and one when it crosses back:

`wedged`, `crash-looping`, `doctor-fail`.

One message per edge. No digest, no daily summary, no list of past alerts and
nothing to acknowledge. The first read of an install after a launch records what
it found and says nothing, so reopening the companion onto a fleet that was
already wedged does not fire everything again.

Notifications are tagged by install and condition, so a clear replaces the raise
it is about instead of piling up beside it. The dock badge counts installs in a
raised condition. There is no tray icon and no login item, on purpose. The badge
is a number on an icon you went looking for, which is a different thing from
being interrupted.

The edge rule is one pure function in `phoebe-agent/contracts`.

## Getting the companion

Distribution is CI artifacts on the `phoebe-agent@x.y.z` GitHub Release, mac
arm64, Windows x64 and Linux x64. **Unsigned, this round.** `electron-updater`
checks once at launch and installs on quit, and the macOS updater is switched off
until there is a Developer ID to notarise with. Self-building from source stays
documented and supported.

## What stays at a shell

The console is deliberately narrower than the CLI, and the line is not where you
might guess.

**Not editable from the console, by design.** The fleet declaration in
`workspace`, because adding or removing a tenant is a git edit. `engine.ref`,
because moving it runs the migrations for the new ref and that belongs with
`phoebe upgrade`. The `deployment` block, whose lifecycle commands run outside
the container. `paths`, which is derived. Any leaf a `PHOEBE_*` variable already
sets, since writing the file would change nothing you would see. Every one of
these refuses with the exact edit to make by hand.

**Deployment-scope secrets.** The GitHub App key and the engine-clone token stay
in the env-file. Rotating one is an edit to `.env` and a `compose up -d`, because
`.env` is Compose's create-time input.

**Operator verbs.** Pause a pipeline, release a quarantined unit, abort a running
unit. None of these exist yet.

## Not here yet

Deployments that run somewhere else. The console reads the installs on this
machine and nothing further away. Unit history and cost, and a mobile app. All
recorded against
[the console map](https://github.com/JesusFilm/phoebe/issues/497).
