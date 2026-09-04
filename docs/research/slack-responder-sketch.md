# Slack responder sketch: naming the extension points

Design record, 2026-08-26. Context: the modular work-kinds map (#303) set its generality
bar at "the five built-ins plus simple custom kinds" and deliberately kept one harder case
as a paper exercise: a Slack bug-channel responder. This record is that exercise. Nothing
here is implemented or scheduled — the sketch exists to prove the v1 contract's _shape_
can host a kind like this, and to give each capability v1 lacks a name and a documented
attachment point, so a future kind author reads the edges as designed edges rather than
oversights.

The contract this sketch is written against is the one resolved on tickets #348 (the
definition object and the three walks), #349 (the ctx surface), and #350 (the config
surface).

## The reference kind

Watch a Slack bug channel. When a report arrives, hold a multi-turn clarifying
conversation with the reporter — one turn per engine cycle, the agent replying in-thread.
When a report is actionable, file a GitHub issue carrying the ready label, so the `issues`
kind picks it up on a later cycle. The responder produces work for Phoebe's existing
pipeline; it never touches the repo itself.

## The sketch

```ts
// phoebe-kinds/slack-responder.ts — tenant module, loaded via
// workKinds.custom["slack-responder"] = { module: "./phoebe-kinds/slack-responder.ts",
//                                         options: { channel: "C0123BUGS" } }
import type { WorkKindDefinition } from "phoebe-agent";

type Thread = {
  ref: string; // "slack:C0123BUGS/1724712345.001200"
  channel: string;
  threadTs: string;
  transcript: string; // rendered thread so far, for the prompt
  state: "awaiting-phoebe" | "awaiting-user";
};

export default {
  name: "slack-responder",
  oneShotEligible: true,
  promptFile: "phoebe-prompts/slack-responder.md",
  workspace: "worktree", // ← bend #1: wants "none"; see extension points
  report: {
    noun: "bug-channel thread(s)",
    describe: (t) => `Slack thread ${t.threadTs} in ${t.channel}`,
  },
  async fetch(ctx) {
    // Read recent threads in the channel via the Slack Web API — plain global
    // fetch(); ctx.github is a convenience, not the frame. The thread itself is
    // the state store, per the house watermark pattern: a marker reaction set by
    // the agent distinguishes handled threads (✅ filed, 💤 awaiting-user) from
    // threads whose newest message Phoebe has not yet answered. A marker only
    // counts as Phoebe's when Phoebe set it — `reactions.get` names who reacted,
    // and anyone else's ✅ is ignored. Slack reactions are open to every channel
    // member, so an unauthenticated marker would let any member silence the
    // responder on a thread; the GitHub kinds have the same rule, matching
    // watermark comments on author login. Per-thread read errors are warned and
    // dropped; a failed channel read throws and the cycle dies — the same
    // failure contract as every kind.
    return readActionableThreads(ctx.options.channel); // Thread[]
  },
  select(gathered, ctx) {
    // Oldest thread waiting on Phoebe first; threads carrying the awaiting-user
    // marker are skipped under a free-string reason, rendered verbatim.
    const unit = gathered.find((t) => t.state === "awaiting-phoebe") ?? null;
    const awaitingUser = gathered.filter((t) => t.state === "awaiting-user").length;
    return {
      unit,
      skipped: awaitingUser > 0 ? [{ reason: "awaiting reporter reply", count: awaitingUser }] : [],
      total: gathered.length,
    };
  },
  async run(unit, ctx) {
    // One conversational turn: the agent reads the transcript, then either asks
    // a clarifying question in-thread, or files a ready-labelled GitHub issue
    // and marks the thread filed. Throw = failure, as everywhere.
    await ctx.agent.run({
      promptArgs: { transcript: unit.transcript, channel: unit.channel },
    }); // ← bends #2–#4: credentials, tools, workspace
  },
} satisfies WorkKindDefinition<Thread[], Thread>;
```

## Where it fits, where it bends

The load-bearing v1 decisions all hold:

- **The opaque unit + structural `ref`** hosts a non-GitHub unit with zero friction.
  `slack:<channel>/<thread-ts>` is stable across cycles, unique within the kind, and
  nothing needs to parse it. Quarantine counting, logs, and the idle report key
  `(kind, ref)` and never notice the source isn't GitHub.
- **Kind-owned fetch** is why this kind is possible by construction. `ctx.github` goes
  unused; global `fetch` against the Slack Web API needs no engine help. **Decision: ctx
  owes a non-GitHub fetch no convenience** — an HTTP helper would be a shallow wrapper
  with no engine knowledge behind it. The extension point is a sentence of documentation
  ("your fetch may call anything reachable"), not API.
- **The idle report** is already source-agnostic: `report.noun`, `report.describe`, and
  free-string skip reasons render Slack threads as naturally as PRs.
- **State in the external system** (the house watermark pattern) maps cleanly: the thread
  is the record, marker reactions/replies are the watermark. No per-kind store is needed —
  reconfirming the map's out-of-scope call.
- **`workKinds.custom` + `ctx.options`** carry the channel id and any tuning without any
  new config surface.

Four places it bends. Each is an extension point below — a one-paragraph future shape and
where it attaches — plus one genuine wrinkle that feeds back into the v1 contract.

## Extension points

### 1. `workspace: "scratch"` / `"readonly"`

The responder needs repo context at most and a branch never; today it must declare
`"worktree"` and waste a checkout per turn. The `workspace` field was declared with one
implemented value precisely so this arrives as data, and #349 made the run-ctx member a
discriminated union so new modes are additive members, not retypes.

**Future shape.** `readonly` → `{ mode: "readonly"; dir: string }` where `dir` is a
worktree prepared and discarded exactly as today, under a documented don't-push
contract — a promise about intent the engine may later enforce, not a new mechanism.
Attaches to: the definition's `workspace` field, the engine's prepare/remove step, and
the `WorkKindRunCtx.workspace` union.

**Shipped (#358, #397).** Both halves landed. `workspace: "scratch"` is
`{ mode: "scratch"; dir: string }`, one empty directory per kind under the tenant's
`scratch/` root. The name moved off `none` because the handle carries a `dir`: there is a
workspace, it just is not a git tree. `workspace: "readonly"` is
`{ mode: "readonly"; dir: string }`, the same worktree the `worktree` arm prepares, but
detached at `origin/<defaultBranch>` and one directory per kind. Both are created on first
read of `dir` and removed with the unit.

The open question this sketch left was what the don't-push contract is worth, and it
resolved against enforcement. A kind holds `ctx.env`, token included, and is trusted as
the tenant. An engine that tried to stop a kind that meant to push would be theatre, and
the trust posture written into extension point 2 says as much. So the contract is a shape.
Detached means no branch is created or moved in the clone and a bare `git push` fails for
want of a refspec, which covers accident, which was all that was ever coverable. The one
engine check runs at the unit boundary and refuses nothing: a readonly tree left dirty or
carrying commits is warned about as it is deleted, so work thrown away is thrown away
loudly. That is the whole mechanism, and it is smaller than either option the ticket
weighed.

### 2. Kind-declared credentials

A Slack token has no home in Phoebe's credential machinery, and `src/agent-env.ts` is a
deliberate exfiltration barrier: the agent child sees only the base allowlist plus the
active provider's key, so a prompt-injected agent can't drain the keyring. Config files
are committed, so the token can't ride `phoebe.config.ts`; it belongs in the tenant `.env`
like every secret.

**Future shape.** One definition field, `requiredEnv: string[]`. Declaring a name means
two things at once: boot fails fast if the var is absent or empty (the
`assertPromptFilesExist` spirit — a misconfigured kind dies at boot, not mid-cycle), and
the var is forwarded to _this kind's_ agent children only, as a per-kind union onto the
allowlist in `buildAgentEnv`. The trust posture covers it — a kind is trusted as the
tenant — but the cost should be named honestly: every declared var punches a deliberate,
kind-scoped hole in the exfiltration barrier; scoping per kind keeps the Slack token out
of the `issues` kind's agents. Attaches to: the definition object, boot validation, and
`buildAgentEnv`.

### 3. Non-GitHub work sources

Already possible by construction — the sketch's fetch proves it, and the decision above
says ctx owes it no HTTP convenience. The narrow real gap is not fetch but **escalation**:
the quarantine/timeout write path is GitHub-shaped. See the wrinkle below, which is a v1
matter, not a future one.

### 4. Agent tool surface

The run helper's environment is GitHub-shaped: the agent child gets `gh`, `git`, and the
provider CLI's built-ins. The responder's agent needs to read and post Slack messages.

**Future shape.** Kind-declared MCP servers: an optional field on the definition (or an
`agent.run` option) the engine passes through to the provider invocation — the direction
all the provider CLIs already support — with each server reading its token from the env
that extension point 2 forwards. The degenerate v0 needs no machinery at all: once
`requiredEnv` exists, the prompt can tell the agent to call the Slack Web API with `curl`
and the forwarded token — which is a useful proof that the four gaps are independent, not
a lattice. Attaches to: the definition object and `agent.run`'s engine-fixed invocation
build.

## The wrinkle that feeds back: the timeout write target

`recordUnitTimeout` (`src/main.ts:423`) today derives its GitHub write target from the
kind name — `issues`/`research` → issue, everything else → PR — and coerces the unit id
to a number, then posts the timeout marker, and at threshold the quarantine label and
escalation comment. Post-migration both derivations are impossible: units are opaque, and
the ref contract (#348) forbids parsing refs. This is not a Slack-only gap — **the
built-ins' own migration strands this path** — the sketch merely exposed it.

**Resolution (amends #348).** The unit's structural obligation grows one optional field,
sibling to `ref`:

```ts
type WorkUnitShape = {
  ref: string;
  github?: { objectType: "issue" | "pr"; id: number };
};
```

When present, the engine's timeout/quarantine write path uses it exactly as today. When
absent — a Slack thread — the unit gets in-memory timeout counting only: the engine logs
that the unit carries no GitHub target and therefore no escalation surface, a defined
degraded behavior instead of a crash.

The skip half does not follow, and the sketch should not pretend otherwise. Quarantine's
read/skip path is a GitHub label filter, so nothing stops a timed-out non-GitHub unit
from being selected again on the next cycle. A kind whose units are not GitHub objects
carries its own guard in the external system — for this responder, the marker reaction it
already uses as its watermark. A source-agnostic quarantine state that the engine itself
could filter on is **un-designed**; naming it here rather than inventing it, it belongs
to whichever map first ships a non-GitHub kind for real.

**Since resolved.** The pipelines map was the map that shipped one. The in-memory count
gained a consumer, `ctx.quarantined`, a per-kind set of refs at the threshold, backed by
an admission drop; the unit's optional `revision` is the way out. Domain terminal states
did stay kind-owned in the external system, as this paragraph expected. See
[Units the engine cannot see](../work-kinds.md#units-the-engine-cannot-see).

Quarantine's marker/baseline logic stays engine-owned — it is subtle enough that per-kind
reimplementation (a definition-level `escalate` hook) was rejected. All five built-ins set
the field in `select`; it costs one line each.

## Verdict

The v1 contract's shape hosts the responder: the opaque unit with a structural `ref`,
kind-owned fetch, the namespaced ctx with `options`, free-string skip reasons, kind-owned
reporting, and the declared `workspace` field all survive contact without strain, and
each gap attaches as an additive field or union member rather than a redesign. **One v1
decision must change before implementation handoff**: the unit's structural type gains
the optional `github` target above, or the engine's timeout and quarantine write path has
no leg to stand on for the built-ins themselves. Everything else — workspace modes, kind
credentials, agent tools — is correctly deferred, and the authoring docs (#351's "Writing
your own kind" section) should list these edges in one line each, linking this record.
