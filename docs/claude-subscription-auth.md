# Running Claude under a subscription (Pro / Max)

By default Phoebe authenticates the `claude` provider with an Anthropic **API
key** (`ANTHROPIC_API_KEY`), billed pay-as-you-go per token. If you have a
Claude **Pro or Max subscription**, you can instead have the containerised
Claude Code CLI run under that subscription — the same plan you use
interactively — so agent runs draw on your subscription's usage limits rather
than API billing.

This needs **no engine code change**. Phoebe already forwards exactly one env
var per provider to the agent child — `providerEnv[provider]` in
`src/agent-env.ts` — so switching Claude from an API key to a subscription token
is a config + env-file change, plus making sure the Claude CLI is in your image.

> **Which auth wins.** The container's Claude CLI accepts a subscription in two
> forms: a long-lived OAuth **token** in `CLAUDE_CODE_OAUTH_TOKEN`, or the
> **credentials file** it writes at login (`~/.claude/.credentials.json`).
> Because Phoebe forwards only the single var named in `providerEnv.claude`,
> pointing that at `CLAUDE_CODE_OAUTH_TOKEN` means `ANTHROPIC_API_KEY` is never
> handed to the agent at all — no ambiguity about which credential is used.
> Do **not** run the provider with `claude --bare`: bare mode ignores OAuth and
> keychain and accepts only `ANTHROPIC_API_KEY`. Phoebe's `claude` provider
> (`src/providers/providers.ts`) does not use `--bare`, so OAuth is honoured.

There are two ways to get the login in. **Approach A (a headless token) is
recommended** and is what the helper script does. Approach B (hoisting your
existing on-disk login) is documented for completeness and for air-gapped cases.

---

## Approach A — a long-lived subscription token (recommended)

The Claude CLI can mint a long-lived OAuth token for exactly this purpose:

```
claude setup-token   # "Set up a long-lived authentication token (requires Claude subscription)"
```

You run this **once on your workstation**, sign in with your Pro/Max account,
and it prints a token (`sk-ant-oat01-…`). That token then travels into the
container as an ordinary environment variable — the same delivery path Phoebe
already uses for every provider secret (compose `--env-file` → `process.env` →
the per-provider allowlist).

### Do it with the helper

```
node scripts/hoist-claude-login.mjs
```

The helper launches `claude setup-token`, waits for you to paste the resulting
token, writes `CLAUDE_CODE_OAUTH_TOKEN=…` into `.phoebe/.env` (mode `0600`), and
prints the two wiring steps below. Flags:

| Flag | Effect |
| --- | --- |
| `--token <sk-ant-…>` | Use a token you already have; skip the interactive flow. |
| `--envfile <path>` | Write to a different env-file (default `.phoebe/.env`). |
| `--no-launch` | Never spawn the CLI; require `--token`, `CLAUDE_CODE_OAUTH_TOKEN`, or a paste. |

`CLAUDE_CODE_OAUTH_TOKEN=… node scripts/hoist-claude-login.mjs` also works if the
token is already in your environment.

### Or do it by hand

1. **Mint the token** on your workstation: `claude setup-token`.
2. **Put it in the env-file** your compose `--env-file` points at (the dogfood's
   is `.phoebe/.env`):

   ```
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
   ```

3. **Point the `claude` provider at that var** instead of the API key, in the
   `phoebe.config.ts` for the repo(s) that run Claude (`providerEnv` is merged
   key-by-key, so this overrides only the one entry):

   ```ts
   providerEnv: { claude: "CLAUDE_CODE_OAUTH_TOKEN" },
   ```

4. **Make sure the Claude CLI is in the image.** In your `Dockerfile`, next to
   the provider-install block, pin and install it (the template ships this line
   commented):

   ```dockerfile
   RUN npm install -g @anthropic-ai/claude-code@<version>
   ```

5. **Rebuild and restart** the container so the new image and env-file take
   effect.

That's it. When the engine next spawns Claude, `buildAgentEnv` forwards
`CLAUDE_CODE_OAUTH_TOKEN` (and not `ANTHROPIC_API_KEY`) to the CLI, which runs
under your subscription.

---

## Approach B — hoist your existing on-disk login

If you'd rather reuse the login the CLI already holds on your machine instead of
minting a token, you can carry its credential file into the container. When you
`claude login` (or `/login`) with a subscription, on Linux the CLI writes the
OAuth grant to:

```
~/.claude/.credentials.json      # mode 0600 — access token, refresh token, expiry, scopes
```

The container's Claude CLI looks for that file under **its** `$HOME`, which the
image sets to `/home/phoebe` (`ENV HOME=/home/phoebe`, user `phoebe`, uid
`10001`). So the file has to land at `/home/phoebe/.claude/.credentials.json`,
readable by uid `10001`.

This is workable but has sharper edges than Approach A — read these before
choosing it:

- **Ownership.** A straight bind-mount of `~/.claude/.credentials.json` carries
  your **host** uid (e.g. `1000`), while the container runs as `phoebe`
  (`10001`). At mode `0600` the container user then can't read it. You must
  either copy the file into a location the image chowns to `phoebe`, or seed it
  into a named volume with the right ownership — not just `-v
  ~/.claude:/home/phoebe/.claude`.
- **Short-lived token + refresh.** The access token in that file expires in
  hours; the CLI refreshes it in place using the refresh token. In a container
  that refresh only survives if `/home/phoebe/.claude` is writable **and
  persisted** (a named volume), otherwise every restart reverts to the stale
  token and eventually fails. A long-lived `setup-token` (Approach A) sidesteps
  refresh entirely.
- **It's still a secret.** Treat the file like the API key: never `COPY` it into
  an image layer, and don't commit it.

If you accept those, the delivery shapes are:

- **Bind-mount a pre-owned copy.** Copy the file to a staging dir you can chown,
  then mount that dir over `/home/phoebe/.claude`, ensuring uid `10001` can read
  it. Keep it writable + on a persistent volume so token refresh sticks.
- **Seed a named volume.** One-time: create a `phoebe-claude-home` volume, drop
  a correctly-owned `.credentials.json` into `/home/phoebe/.claude` inside it,
  and mount it there for the container.

Because refresh-in-place makes this fragile for a long-lived daemon, prefer
Approach A for anything you're not actively babysitting.

---

## Security notes

- **Per-tenant isolation still applies.** `CLAUDE_CODE_OAUTH_TOKEN` is scrubbed
  and forwarded by the same allowlist as any provider key
  (`src/agent-env.ts`): a Claude tenant gets only its own token, and a
  same-machine sibling tenant on a different provider never sees it. The `node`
  execute-only guard (`chmod 0711`, Dockerfile) that keeps one tenant from
  reading another's `/proc/<pid>/environ` covers this token too.
- **Never bake it into the image.** Both the token and the credentials file are
  secrets and belong on the env-file / a runtime mount, delivered via compose
  `--env-file` — never a `COPY` or build `ARG`.
- **Rotation.** To revoke, remove the token from the env-file (and revoke it in
  your Claude account) and restart. A `setup-token` token is long-lived but not
  eternal; if agent runs start failing auth, mint a fresh one and re-run the
  helper.
- **Terms of use.** Subscription auth is intended for individual use. A
  persistent, unattended Phoebe deployment — especially multi-tenant or on
  shared infrastructure — is squarely what the API tier exists for; keep the
  subscription path for your own single-operator instances and use an API key
  where the API tier is the right fit.

## Verify it worked

After rebuild + restart, trigger a Claude unit and confirm the run authenticates
(no `Invalid API key` / auth error in the agent stream, and the work completes).
A quick isolated check of the token itself, outside Phoebe:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-… claude -p "say hi" --model claude-sonnet-4-6
```

If that returns a completion, the container will authenticate the same way.

See also: [configuration.md](configuration.md) for `providerEnv` and the
`PHOEBE_*` overlay, and [operating.md](operating.md) for driving runs.
