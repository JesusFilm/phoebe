# How hatsu turns Slack into issues

Research for [#405](https://github.com/JesusFilm/phoebe/issues/405) on the pipelines map
([#400](https://github.com/JesusFilm/phoebe/issues/400)), read 2026-09-02 directly from the
[JesusFilm/hatsu](https://github.com/JesusFilm/hatsu) source at commit
`a321d77ae7ad56cdc99c900b2fa637fe702e68b4` (referred to below as `a321d77`). Every claim
cites the file that owns it; nothing here is from a secondary write-up.

Hatsu is an autonomous bug-fixing pipeline for `JesusFilm/core`: **Piper** (intake,
Slack-facing), **Cade** (build), **Vera** (QA), plus a **hatsu** observer persona
([README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/README.md)).
The Slack→issues path is Piper's; the facts below are what the intake-contract decision
on #400 waits on.

## The short answers

- **Inbound ingress: not required.** Slack delivery is **Socket Mode** — an outbound
  WebSocket held open by a NanoClaw instance; setting the app-level token is explicitly
  "what selects Socket Mode over a public webhook endpoint. We have no public endpoint,
  so it is required, not optional"
  ([infra/watcher/nanoclaw-shim/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/infra/watcher/nanoclaw-shim/README.md),
  "Slack app setup (P9)"). The only HTTP listener in the wake path is the watcher's own
  loopback server, bound to `127.0.0.1` and unauthenticated precisely because it must
  never be reachable off-host
  ([infra/watcher/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/infra/watcher/README.md),
  `server.ts` entry). NanoClaw's stock webhook listener on `0.0.0.0:3000` exists but is
  inert (405 to everything without a signing secret; probed live) — an exposed port to
  close, not a dependency (shim README, "The live install").
- **Tokens:** two separate Slack apps with separate tokens and scopes — **hatsu** inward
  (cockpit/alerts) and **Piper** outward (talks to reporters) — so neither is "the Slack
  token" and one can rotate without the other
  ([README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/README.md)).
  Piper's side needs a **bot token** (`xoxb-`, env `HATSU_SLACK_TOKEN` for the watcher's
  Web API calls; `SLACK_BOT_TOKEN` for NanoClaw) **and an app-level token** (`xapp-`,
  scope `connections:write` — the Socket-Mode switch). Named bot scopes/events in the
  shim README: bot events `message.channels`, `message.groups`, `app_mention`
  (deliberately **not** `message.im`), Interactivity on, and `im:write` (owner-approval
  DMs). Secrets come from Doppler, rendered to a cache in `/etc/hatsu/` on the VM —
  never the repo (README.md; shim README "The live install").
- **Cadence — "runs constantly" means a long-lived event-driven daemon, not a poll
  loop.** Two processes stay up: the NanoClaw instance holding the Slack socket (a user
  systemd unit, `nanoclaw-piper.service`) and the watcher, a Node process whose only
  timer is a **silence-clock sweep, default every 60 s** (`sweepIntervalSeconds: 60`,
  `0` = off,
  [config/schema.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/config/schema.ts)
  `CONFIG_DEFAULTS`). Message handling is push (socket → shim → loopback POST), not
  polling; the sweep exists only to nudge silent reporters, and skips itself if the
  previous sweep is still running
  ([infra/watcher/main.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/infra/watcher/main.ts) —
  the interval is deliberately not `unref`'d: "this interval is the reason the process
  stays alive when no message is arriving").

## Ingestion: how a Slack message becomes a wake

```
Slack ──socket──▶ NanoClaw router
                      │ message interceptor (plain code, no LLM)
                      └▶ POST 127.0.0.1:8787/wake ──▶ watcher ──▶ runPiperCycle
```

- A tiny **interceptor** (`piper-wake.ts`) is the only pipeline code inside NanoClaw. It
  runs before any agent session, claims messages on wired channels, decodes NanoClaw's
  encoded ids back to Slack's (`slack:C…:ts` → channel + ts, `piper-decode.ts`), and
  POSTs to the watcher. No LLM in the wake path
  ([infra/watcher/nanoclaw-shim/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/infra/watcher/nanoclaw-shim/README.md)).
- **The event is facts, never judgement**: thread (`channel` + `threadTs`), a timestamp
  the watcher stamps itself, display names, and `botUserId`. The watcher "decides
  nothing about the conversation" — Piper re-reads the thread every cycle and works out
  for herself whether this is a new report, a reply, or silence, so a mislabelled event
  is impossible rather than unlikely
  ([infra/watcher/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/infra/watcher/README.md)).
- The **reads are then Web API pulls** made by the cycle itself:
  `conversations.history` (one 100-message newest-first window, no pagination) and
  `conversations.replies` (cursor-paginated to the end — a thread is promised in full),
  plus `chat.postMessage` for replies, all plain `fetch` against `https://slack.com/api/*`
  with a Bearer bot token
  ([platform/slack/slack-api.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/platform/slack/slack-api.ts)).
  So the architecture is **push-to-wake, pull-to-read** — events carry no content that
  is trusted, only the address of a thread to go read.
- **Rate-limit fact worth keeping:** the app must stay internal to the workspace —
  Slack's May-2025 change caps `conversations.history`/`replies` at 1 req/min for
  commercially distributed non-Marketplace apps, vs 50+/min for internal apps; enabling
  distribution "would throttle Piper's thread reads into uselessness" (shim README).
- Channel onboarding is runtime, not config: invite the bot, an owner approves a card in
  DM, no channel list in the repo (shim README, "The live install").

## Authentication, in detail

| Credential                                       | Holder                                 | Purpose                                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HATSU_SLACK_TOKEN` (bot `xoxb-`)                | watcher (`main.ts` → `createSlackApi`) | Piper's Web API reads/posts                                                                                                                                                                                |
| `SLACK_BOT_TOKEN` (same app's `xoxb-`)           | NanoClaw `.env`                        | the socket-side bot identity                                                                                                                                                                               |
| `SLACK_APP_TOKEN` (`xapp-`, `connections:write`) | NanoClaw `.env`                        | Socket Mode — required, "no public endpoint"                                                                                                                                                               |
| `SLACK_SIGNING_SECRET`                           | NanoClaw `.env`                        | present in the credential set; the webhook route it would authenticate is unused/inert                                                                                                                     |
| GitHub                                           | `gh` login of the VM processes         | a dedicated bot account (`siyang.bot@gmail.com`), never personal ([harnesses/piper/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/harnesses/piper/README.md)) |

All deployment data is environment, rendered from Doppler (project `hatsu`, config `prd`)
into `/etc/hatsu/` on every service start; the repo commits no secrets and no workspace
identifiers (README.md; watcher README "Configuration"; shim README "The live install").
The Slack app is created **by hand**, not by NanoClaw's provisioning wizard, so Doppler
stays the source of truth for rotation (shim README, P9).

## Deduplication: no cursor, no seen-set — state is re-derived

The watcher holds **no conversation state**: "There is no cursor, no seen-set, and no
'what did I already deliver' table, which is why a restart costs latency and nothing
else" (watcher README). Dedup is layered instead:

1. **GitHub is the only state store.** The interview ledger rides in the issue body as
   one `<!-- piper:ledger … -->` comment line; Piper re-derives where she is each cycle
   by re-reading the Slack thread and the ticket
   ([harnesses/piper/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/harnesses/piper/README.md),
   `steps/ticket-body.ts`, `steps/ledger.ts`).
2. **Idempotent effects.** "Every effect checks what is true first: don't move a ticket
   that is already there, don't repeat a comment already posted, and finish rather than
   re-investigate when the ledger records a review that already passed" (piper README,
   packet 5). Relayed messages carry a `· message` marker read back via the tracker's
   `listComments` (`alreadyCarried`) so a Slack `ts` is never carried onto a ticket
   twice.
3. **Per-thread serialisation with burst collapse.** `infra/watcher/queue.ts` runs one
   cycle at a time per thread and collapses N wakes during a run into one follow-up
   cycle — ten wakes and one wake see the same world because the cycle re-reads the
   whole thread. `maxConcurrentCycles` (default 4) caps the total.
4. **Self-recognition** is by ledger `ts` plus the watcher-supplied `botUserId` (refusal
   only, never attribution), and NanoClaw's `slack-a2a-guard` drops bot-authored inbound
   before the interceptor, so Piper cannot wake herself (piper README; shim README).
5. **The accepted residual race:** two cycles on the _same_ thread with no ticket yet can
   both open one — tolerated as a crash-window backstop, with the watcher's
   one-cycle-per-thread rule as the plan (piper README, packet 5).

## Issue shaping

- Piper opens the ticket **in Triage the moment she judges a message a real report**,
  then keeps rewriting the body while it sits there — the tracker's emitter port
  enforces that bodies are rewritable only in Triage
  ([harnesses/piper/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/harnesses/piper/README.md);
  [platform/tracker/emitter.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/platform/tracker/emitter.ts)).
- Shaping is **LLM work at every step**: agentic nodes `acknowledge`, `classify`
  (bug | improvement | not-a-report), `interview-step` (question budget of four, one
  nudge, silence → park), `investigate` (a full ticket document produced in a read-only
  "reading room" worktree of the target repo, then a grill/respond dialogue that
  stress-tests the diagnosis), and `review` (a cold reader as the readiness gate)
  (piper README, packets 2–4; `harnesses/piper/agents/`, `prompts/`).
- The result is `TicketDraft { title, body }` with the ledger hidden at the end of the
  body; ticket state is the **GitHub Projects board Status field** (Triage → Ready →
  … → Done, ids cached in
  [hatsu.config.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/hatsu.config.ts)),
  and the body must pass a ticket contract (`platform/ticket/`, `validateTicket`) before
  promotion. Failure exits carry machine-readable handover tags (`needs-human`,
  `decision-needed`, `sent-back`, `reopened-for-human`) in canned comment text so the
  watchdog can grep for trouble.
- Creation is one `createIssue({ title, body, labels, milestone, status })` call that
  also places the row on the board. **Labels:** exactly one, the pipeline opt-in marker
  (`labels.autoWorkflow`, default `ai-auto-workflow`) — workflow state lives in the
  Status field, never in labels. **Milestone:** every ticket carries `bugs` or
  `improvements` (`config.milestones`)
  ([platform/tracker/emitter.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/platform/tracker/emitter.ts);
  [config/schema.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/config/schema.ts)).
- **Repo targeting is fixed, not per-message**: `hatsu.config.ts` is "THE single file
  allowed to name the target repository" (`JesusFilm/core`), enforced by a seam test
  that fails if any other file names it
  ([hatsu.config.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/hatsu.config.ts);
  [config/config-seam.test.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/config/config-seam.test.ts)).
- **Provenance footer:** each ticket references its thread the one canonical way —
  a real archives permalink (`<slack.workspaceUrl>/archives/<channel>/p<ts sans dot>`)
  when the workspace URL is configured, otherwise an honest `channel / ts` pair ("a
  fabricated link that 404s is worse") — plus the intake run id back into the log trail
  ([harnesses/piper/steps/ticket-notes.ts](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/harnesses/piper/steps/ticket-notes.ts)).
- After Triage, Piper only **relays** later reporter messages onto the ticket verbatim;
  a revived closed-ticket thread always goes to a person (piper README, packet 5).

## What "runs constantly" costs — the phoebe-relevant readout

- **No inbound ingress anywhere**: Socket Mode outbound WebSocket + loopback-only HTTP
  between the two local processes. An always-on Slack intake à la hatsu needs an
  outbound-capable long-lived process, not a public URL.
- **Two long-lived processes**, systemd-supervised (the NanoClaw socket holder is live as
  a user unit; the watcher's unit is planned, ENG-3737 —
  [infra/README.md](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/infra/README.md)).
  Runtime is Node ≥22 running TypeScript directly (`--experimental-strip-types`,
  [package.json](https://github.com/JesusFilm/hatsu/blob/a321d77ae7ad56cdc99c900b2fa637fe702e68b4/package.json)).
- **The only polling is the 60 s silence sweep**, and it is optional (`0` = message
  wakes only, called "a real choice for a first supervised run, not a broken state" —
  config/schema.ts). Everything else is event-driven with on-demand Web API reads.
- **Per-pipeline credentials are already hatsu's practice**: two Slack apps, separately
  scoped and separately revocable, plus a dedicated GitHub bot login — the same
  separation #400's "per-pipeline credentials/scopes" bullet anticipates.
- **Crash tolerance comes from statelessness**: because intake state lives in the issue
  body and everything is re-derived, restart/redeploy of the intake pipeline loses
  latency only — a property worth requiring of any phoebe intake pipeline contract.

## Slack platform constraints (from Slack's docs, corroborating the above)

A parallel pass over Slack's own documentation (see the second comment on
[#405](https://github.com/JesusFilm/phoebe/issues/405)) confirmed the load-bearing facts
from the outside — Socket Mode needs no public Request URL, `connections:write` is the
Socket-Mode switch, and the internal-vs-distributed rate-limit split is exactly as the
shim README describes. It also surfaced four platform limits any phoebe Slack intake
inherits:

- **Ten concurrent WebSocket connections per app** — a ceiling on socket-holding
  processes if intake ever runs per-tenant against one shared Slack app
  ([Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)).
- **The socket URL refreshes regularly**: Slack sends a disconnect warning ~10 s ahead,
  or a `refresh_requested` demanding immediate reconnection — a socket holder is not
  fire-and-forget.
- **30,000 event deliveries per workspace per app per 60 minutes**, then
  `app_rate_limited`.
- **If intake ever moves to HTTP**, events must be acked within 3 s; retries run
  immediate / 1 min / 5 min, and Slack disables event subscriptions above 95% delivery
  failure in a 60-minute window (apps under 1,000 events/hour exempt)
  ([Events API](https://docs.slack.dev/apis/events-api/)). Since `phoebe boot`
  relaunches the engine when the ref or config moves, an HTTP intake would drop events
  across every relaunch, where a Socket-Mode restart costs latency and nothing else.

One caveat the other way: Slack recommends Socket Mode for local development and HTTP
Request URLs for deployed team apps, and Socket Mode is barred from the public Slack
Marketplace. Neither binds an internal app; both would bite if this ever ships as a
distributed product.
