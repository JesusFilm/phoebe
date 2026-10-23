# The console

Phoebe runs unattended, which is the point of it and also the problem. A
container that needs no babysitting gives you nothing to look at, and the two
questions an operator has are "is it alive" and "why did that unit fail". Until
now the honest answer was to open a shell and read `phoebe status`.

The **console** is the same answer in a window. It shows every Phoebe install on
your machine, what each one is doing right now, and the settings each one
resolved. The **companion**, a desktop app, is what opens it.

Two pieces, and you can stop after the first:

| Piece           | What it is                                                                                                            | You need it when                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `phoebe status` | The deployment report, read on the host. No network, no sign-in.                                                      | You have a shell on the machine.                                      |
| The companion   | A desktop app. The console window over the local installs on this machine, and the deployments paired over Tailscale. | You run Phoebe on your laptop, or somewhere else, or you want alerts. |

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
scaffold goes into `.phoebe/` under the folder, the tenant's config moves in
with it, and the root is left a
[pointer](configuration.md#one-config-for-a-repo-deployed-two-ways) to it, so
the workspace and the new deployment run on one config and one `.env`. The
folder stays a tenant.

The move is refused where it would break the tenant, and the tenant's top-level
settings are copied into `.phoebe/` in its place: a config that names a file
relative to itself, a config already sitting in `.phoebe/`, a `configDir` that
names some other folder, or a workspace above on an older `phoebe-agent` than
the companion, which may hold a tenant whose root is a pointer. The run says
which, and what is left to do by hand to get back to one config.

The companion adds no listener to the deployment container. Main spawns
`docker compose` exactly as you would at a shell, and reads through
`compose exec`. An install has three states: running, stopped and not
initialised. Compose answers directly, so there is nothing to infer from silence.

A **rail** runs down the left with every deployment on it, always, whatever page
you are on, because "is everything alive" is the question this thing exists to
answer. It lists machines: **This machine** first, with the local installs,
then one section per remote host with the hostname as its header, holding every
deployment paired there, then **+ add remote**. A workspace opens out to its
children, and each child's gear opens that tenant's own config. A child's row says whether it is working, whether it is
switched on, and how many errors and warnings it has, each named on hover; the
workspace's own line sums them, so a closed workspace still shows that
something under it needs a look. One of those errors the companion finds
itself, on the host: a tenant `.env` the container's unprivileged user cannot
read. The tenant's page opens on it with a button that grants that user read
access to the one file.

A right-click on the console's lines offers Copy, Copy line, Copy all lines and
Select all; on a field, the usual edit menu; on any selected text, Copy. On an
install or a tenant in the rail it offers Open folder and Open in terminal: the
file manager on the folder, or a shell started in it. A WSL install's shell
runs inside its distro.

The console's **cli** tab holds what `phoebe` printed when the companion last
ran a verb on the install (a start, a stop, an upgrade, a doctor, a config
edit), with the runs it has watched kept above the current one. The install
tab says which verb ran and how it ended, and links there.

The eraser in the console's header clears the tab you are on. The console stops
drawing that tab's lines and pins itself to the newest line again. The tabs
stay, and so does the reason the stream ended. Pressed on **all** it covers the
whole stream, pressed on a pipeline's tab that pipeline alone, and a line
cleared there is gone from **all** too. Nothing is thrown away. Docker holds the
output, so a console closed and reopened tails the last two hundred lines
afresh. On the **cli** tab the button drops the runs kept above the current one
and the lines that run has printed so far.

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

A container that runs as root is flagged on the rail, in the console's header
and at the top of the install tab, with **Rebuild and restart**: Claude Code
refuses to run as root, and a container is root when its image is older than
the Dockerfile that drops privileges. After that rebuild its volumes are still
root's, so the same places flag what the container cannot write under `/data`,
with **Give them to the container's user**. A tool a config's commands start
with (`vp`, `pnpm`, `yarn`, `bun`) that the container lacks is flagged the same
way, with a button that writes its install into the Dockerfile. Claude Code saying
it is not logged in is flagged too, with **Sign in to Claude**, which opens
`claude setup-token` in a terminal and takes the token it prints as a secret.

The install tab's **Phoebe** section lists the launcher (`phoebe-agent`, pinned
in `container/Dockerfile`) and the engine (`engine.ref` in the config), each
with a field and a button that runs `upgrade` for that half.

The install tab's **AI harness** section lists every agent CLI the container
could carry (Cursor's `agent`, Claude Code, Codex): the version
`container/Dockerfile` pins, the one the running container has, and, after
**Check for updates**, the newest published. Each row can pin a version in the
Dockerfile, add the harness when the Dockerfile lacks it, or remove it, and
**Rebuild and restart** puts the result in the container. Under the list, the
provider, model and effort a config runs are set as the config form sets them. A tenant's
page shows the same for the one harness its provider runs. The container is the
workspace's, so the pin it moves is shared by every tenant.

## Remotes

A deployment somewhere else reaches the companion over Tailscale
([`remote.md`](remote.md)). A **route** is one way of reaching a deployment:
the local route is a folder on this machine read over `compose exec`, the
remote route is a paired record read over the deployment API. One deployment
can have both, and the companion draws both. The folder sits under This machine
with its install tab; the paired record sits under its host's section, read as
any other device would read it, with no install tab. Each row and each page
carries a chip that opens the other, `↗ this machine` or `↗ <hostname>`.

A remote's row says what the companion itself can tell: connected looks like a
local row with its counts; reconnecting keeps the counts and adds a spinner;
dark replaces them with `dark · 3 min`; blocked is a warning-tone row naming
why (session expired, session revoked, a different deployment answers here,
newer than this companion) with **pair again**, or **update** for the last.
From three days before a session's expiry the row says so. Tailscale off on
this machine is a line above the host sections and a banner on the home page.

**+ add remote** opens one modal with one field, which takes the pairing link
`phoebe pair` printed or a bare address; a bare address shows a code field.
Plus a label for this device. It says where the row landed: a new host, an
existing one, or a second route for a folder already here. **Sign out** on a
remote's connection card removes the row, and its section when it was the last;
a joined deployment's folder stays under This machine. A blocked row stays until
you pair again or **forget** it.

The remote route's page has the same five tabs as a local install's. Its
connection card shows reachability, the host, the arm, the protocol, when it
was last heard from, the session's scopes and expiry, and sign out. Under the
cards, on remote routes and on local installs that carry a `remote` block, the
**Devices** panel lists every session the deployment holds: label, device and
OS, who paired, scopes, last seen, expiry, a revoke per row that needs
`operate`, sign out on your own row, and a red banner when the deployment says
its sessions file moved under it. On a read-only session the controls that
change the deployment are disabled and say so.

The install tab gains a **Remote** step after Run: what to add to
`phoebe.config.ts` when there is no `remote` block, and with one, **Pair this
companion** (mints with `--operate` and spends the code itself) and **Link for
another device** (the link, the code in large type, copy buttons, a QR, and
when it stops being spendable). The run's lines say "code minted" and never
the code.

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
edit. A setting that takes a list as well as its named values gets one more
item in its select. Picking it opens a comma-separated box, and the row saves
what's in the box as a list. The settings catalogue decides which settings
those are, and `prScope` is the only one so far. The secret form hands the value to the running container's tenant store,
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

A remote adds `dark`, raised five minutes after the companion last heard from
it ("unreachable for 5 min"), and `replaced`, when a different deployment
answers at a paired address. Blocked is never an alert; nobody is paged for a
session ending. A deployment reachable two ways is evaluated once per route,
so a wedge counts twice on the badge while both routes can see it. The
companion remembers when it last heard from each remote and what it already
notified, so a relaunch dates darkness from real last contact and fires nothing
twice.

One message per edge. No digest, no daily summary, no list of past alerts and
nothing to acknowledge. The first read of an install after a launch records what
it found and says nothing, so reopening the companion onto a fleet that was
already wedged does not fire everything again.

Notifications are tagged by route and condition, so a clear replaces the raise
it is about instead of piling up beside it. The dock badge counts rows in a
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
unit. None of these exist yet, locally or over the API.

**Minting a pairing code.** `phoebe pair` runs as root inside the container
and the companion runs it for you from the install tab on a local install. A
remote route cannot mint for its own deployment; that is the shell's or the
machine that holds the folder.

## Not here yet

Unit history and cost, and a mobile companion, which will scan the same QR and
speak the same API as the desktop one. Recorded against
[the console map](https://github.com/JesusFilm/phoebe/issues/497) and
[the remote-access map](https://github.com/JesusFilm/phoebe/issues/690).
