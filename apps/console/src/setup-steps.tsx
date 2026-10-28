// The setup steps: a fresh install taken from a folder to a running
// deployment, one step at a time, at the top of the install tab.
//
// A deployment is `init`, then a `.env` with two secrets in it, then `start`.
// The install tab has had every one of those buttons for a while; what it did
// not have was the order, or any help with the `.env`. These steps are that
// order. They show while the install is not initialised or has no `.env`, and
// stay for the rest of the session once shown, so a step that just put the
// `.env` there does not make the steps after it vanish.
//
// The GitHub step is the one with something new in it. GitHub's token page
// takes the name, owner, lifetime and permissions in the URL
// (github-token.ts), so the link opens a page with the five grants already
// ticked and the repository left to pick. The pasted token is then checked
// against the repo with the probes that mutate nothing, and saved as GH_TOKEN
// through the same `secret set` the form below the steps uses. A token with a
// grant missing is said so, grant by grant, with the save still offered: the
// operator may know something the probe does not.
//
// Nothing here holds a value longer than the field does. The token goes to
// main for the check and again for the save, and the field clears on save.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  GithubAppCreated,
  GithubAppRequest,
  GithubTokenVerdict,
  LocalInstall,
  LocalReportEvent,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import {
  grantReading,
  isPlaceholderSlug,
  looksLikeToken,
  providerKeyOf,
  slugOf,
  tokenPageUrl,
} from "./github-token.ts";
import { providerOf } from "./harness.ts";
import { secretSetRequest } from "./local-install.ts";

export const GH_TOKEN_KEY = "GH_TOKEN";
export const GH_APP_ID_KEY = "GH_APP_ID";

/**
 * Whose App it would be: the one owner every tenant's slug shares, or the solo
 * install's. Null with nothing to read; `mixed` when the tenants span owners,
 * which the App arm cannot serve (docs/github-app-mode.md §1).
 */
export function appOwnerOf(
  install: LocalInstall,
  slug: string | null,
): { owner: string | null; mixed: boolean } {
  if (install.workspace === undefined) {
    return { owner: slug === null ? null : (slug.split("/")[0] ?? null), mixed: false };
  }
  const owners = new Set<string>();
  for (const child of install.workspace.children) {
    const owner = child.slug?.split("/")[0];
    if (owner !== undefined && owner.length > 0 && !isPlaceholderSlug(child.slug ?? "")) {
      owners.add(owner);
    }
  }
  if (owners.size > 1) return { owner: null, mixed: true };
  return { owner: [...owners][0] ?? null, mixed: false };
}

/** Whether the steps apply to this install at all: an install of its own that is not up yet. */
export function setupApplies(install: LocalInstall, report: LocalReportEvent | null): boolean {
  if (install.tenantOnly === true) return false;
  if (install.state === "not-initialised") return true;
  if (install.state === "running") return false;
  return report !== null && report.install === install.dir && !report.directory.envPresent;
}

export function SetupSteps({
  install,
  report,
  run,
  running,
  trouble = null,
  onStart,
  onVerifyToken,
  onCreateApp,
}: {
  install: LocalInstall;
  report: LocalReportEvent | null;
  run: VerbRun | null;
  running: boolean;
  /** Why main refused the last run this page asked for, or null. */
  trouble?: string | null;
  onStart: (request: VerbRunRequest) => void;
  /** The five-grant probe, through main. Absent where there is no bridge. */
  onVerifyToken?: (slug: string, token: string) => Promise<GithubTokenVerdict>;
  /** The App manifest flow, through main. Absent where there is no bridge. */
  onCreateApp?: (request: GithubAppRequest) => Promise<GithubAppCreated>;
}) {
  const initialised = install.state !== "not-initialised";
  const workspace = install.workspace !== undefined;
  const fields = report?.install === install.dir ? report.directory.configFields : undefined;
  const stated = slugOf(fields);
  const placeholder = stated !== null && isPlaceholderSlug(stated);
  const slug = placeholder ? null : stated;
  const { owner: appOwner, mixed: mixedOwners } = appOwnerOf(install, slug);
  const provider = providerOf(fields);
  const providerKey = provider === null ? null : providerKeyOf(fields, provider);
  // The App, once GitHub answered. Its id is in the .env; the install link is
  // what the step still has to say.
  const [app, setApp] = useState<GithubAppCreated | null>(null);

  // Which keys a `secret set` run saved this session, read off each run's exit.
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const lastExit = useRef<string | null>(null);
  useEffect(() => {
    const outcome = run?.exit?.outcome;
    if (run === null || outcome === undefined || outcome.verb !== "secret set") return;
    if (lastExit.current === run.runId) return;
    lastExit.current = run.runId;
    setSaved((held) => new Set([...held, outcome.outcome.key]));
  }, [run]);

  const steps: { done: boolean; title: string; body: React.ReactNode }[] = [
    {
      done: initialised,
      title: "Initialise the folder",
      body: initialised ? (
        <p className="muted">
          <code>phoebe.config.ts</code> and <code>container/</code> are in place.
        </p>
      ) : (
        <>
          <p className="muted">
            <code>phoebe init</code> writes the config, the container files and an{" "}
            <code>.env.example</code> into this folder. Nothing runs yet.
          </p>
          <div className="verbs">
            <button
              type="button"
              disabled={running}
              onClick={() => onStart({ install: install.dir, verb: "init" })}
            >
              Initialise
            </button>
          </div>
        </>
      ),
    },
    {
      done: saved.has(GH_TOKEN_KEY) || app !== null,
      title: workspace
        ? "Give Phoebe access to the repositories"
        : "Give Phoebe access to the repository",
      body:
        app !== null ? (
          <AppCreated app={app} />
        ) : (
          <>
            {workspace ? null : (
              <GithubStep
                install={install}
                slug={slug}
                placeholder={placeholder ? stated : null}
                initialised={initialised}
                run={run}
                running={running}
                trouble={trouble}
                saved={saved.has(GH_TOKEN_KEY)}
                onStart={onStart}
                {...(onVerifyToken === undefined ? {} : { onVerifyToken })}
              />
            )}
            {saved.has(GH_TOKEN_KEY) ? null : (
              <AppStep
                workspace={workspace}
                owner={appOwner}
                mixed={mixedOwners}
                initialised={initialised}
                onCreated={setApp}
                {...(onCreateApp === undefined ? {} : { onCreateApp })}
              />
            )}
          </>
        ),
    },
    {
      done: providerKey !== null && saved.has(providerKey),
      title: "Give Phoebe an agent to run",
      body: (
        <ProviderStep
          install={install}
          provider={provider}
          providerKey={providerKey}
          initialised={initialised}
          running={running}
          saved={providerKey !== null && saved.has(providerKey)}
          onStart={onStart}
        />
      ),
    },
    {
      done: install.state === "running",
      title: "Start it",
      body:
        install.state === "running" ? (
          <p className="muted">The container is up. The report tabs read from it.</p>
        ) : (
          <>
            <p className="muted">
              <code>phoebe start</code> builds the image and brings the container up. Run{" "}
              <code>doctor</code> after it for the deployment&apos;s own verdict on the two secrets.
            </p>
            <div className="verbs">
              <button
                type="button"
                disabled={running || !initialised}
                onClick={() => onStart({ install: install.dir, verb: "start" })}
              >
                Start
              </button>
            </div>
          </>
        ),
    },
  ];

  return (
    <section className="setup-steps" aria-labelledby="setup-steps">
      <h2 id="setup-steps">Set up this install</h2>
      <ol className="steps">
        {steps.map((step, index) => (
          <li key={step.title} className={step.done ? "step done" : "step"}>
            <h3>
              <span className="step-number" aria-hidden="true">
                {step.done ? "✓" : index + 1}
              </span>{" "}
              {step.title}
            </h3>
            {step.body}
          </li>
        ))}
      </ol>
    </section>
  );
}

function GithubStep({
  install,
  slug,
  placeholder,
  initialised,
  run,
  running,
  trouble,
  saved,
  onStart,
  onVerifyToken,
}: {
  install: LocalInstall;
  slug: string | null;
  /** The scaffold's placeholder slug, when the config still carries it. */
  placeholder: string | null;
  initialised: boolean;
  run: VerbRun | null;
  running: boolean;
  trouble: string | null;
  saved: boolean;
  onStart: (request: VerbRunRequest) => void;
  onVerifyToken?: (slug: string, token: string) => Promise<GithubTokenVerdict>;
}) {
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<GithubTokenVerdict | null>(null);
  const [checkTrouble, setCheckTrouble] = useState<string | null>(null);
  // The save this step asked for, as the run that was current when it asked:
  // the next `secret set` run to exit after it is this one's.
  const [saving, setSaving] = useState<{ after: string | null } | null>(null);
  const [saveTrouble, setSaveTrouble] = useState<string | null>(null);

  // A save that was refused or failed takes the verdict with it: the token has
  // left the field, and a verdict left standing would read as saved.
  useEffect(() => {
    if (saving === null) return;
    if (trouble !== null) {
      setSaving(null);
      setVerdict(null);
      setSaveTrouble(`The save did not start: ${trouble}`);
      return;
    }
    if (run === null || run.runId === saving.after || run.verb !== "secret set") return;
    if (run.exit === undefined) return;
    setSaving(null);
    if (run.exit.code !== 0) {
      setVerdict(null);
      setSaveTrouble(
        `Saving ${GH_TOKEN_KEY} failed (exit ${run.exit.code}). The console's cli tab has what the run said. Paste the token again to retry.`,
      );
    }
  }, [saving, trouble, run]);

  function save(): void {
    setSaveTrouble(null);
    setSaving({ after: run?.runId ?? null });
    onStart(secretSetRequest({ install, key: GH_TOKEN_KEY, value: token.trim() }));
    // The field empties; the verdict stays until the run says the save failed.
    setToken("");
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (slug === null || onVerifyToken === undefined) {
      save();
      return;
    }
    setChecking(true);
    // The last verdict was about the last token; it must not stand beside this one.
    setVerdict(null);
    setCheckTrouble(null);
    setSaveTrouble(null);
    onVerifyToken(slug, token.trim()).then(
      (read) => {
        setChecking(false);
        setVerdict(read);
        if (read.ok) save();
      },
      (error: unknown) => {
        setChecking(false);
        setCheckTrouble(error instanceof Error ? error.message : String(error));
      },
    );
  }

  if (saved) {
    return (
      <p className="muted">
        <code>{GH_TOKEN_KEY}</code> is in this install&apos;s <code>.env</code>.
      </p>
    );
  }

  return (
    <>
      <p className="muted">
        Phoebe works the repository as a GitHub token&apos;s identity: it clones, pushes{" "}
        <code>phoebe/</code> branches, opens pull requests and moves issue labels. A fine-grained
        token with five grants is what it is built for.
      </p>
      {placeholder !== null ? (
        <p className="refusal">
          The config still says <code>{placeholder}</code>, which is what <code>phoebe init</code>{" "}
          writes as a placeholder. Set <code>repoSlug</code> to the real repository on the config
          tab first; the token link and the check need it.
        </p>
      ) : slug === null ? (
        <p className="muted">
          {initialised
            ? "The config does not state a repoSlug, so the token cannot be checked here. Create one on GitHub with Contents, Pull requests and Issues read and write, Actions read-only, and paste it below."
            : "Initialise the folder first, so the config names the repository the token is for."}
        </p>
      ) : (
        <p className="muted">
          <a href={tokenPageUrl(slug)}>Create a token on GitHub</a> opens the page with the grants
          ticked, a year&apos;s lifetime and <code>{slug.split("/")[0]}</code> as the owner. Pick{" "}
          <em>Only select repositories</em> and choose <code>{slug.split("/")[1]}</code>; the page
          cannot be told that part. A token on an organisation&apos;s repository needs an
          owner&apos;s approval before it works.
        </p>
      )}
      <form className="verbs" onSubmit={submit}>
        <input
          aria-label="GitHub token"
          type="password"
          autoComplete="off"
          placeholder="github_pat_…"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button
          type="submit"
          disabled={running || checking || !initialised || !looksLikeToken(token)}
        >
          {checking
            ? "Checking…"
            : slug === null || onVerifyToken === undefined
              ? `Save as ${GH_TOKEN_KEY}`
              : "Check and save"}
        </button>
      </form>
      {checkTrouble === null ? null : (
        <p className="refusal">The check did not run: {checkTrouble}</p>
      )}
      {saveTrouble === null ? null : <p className="refusal">{saveTrouble}</p>}
      {verdict === null ? null : (
        <div className="token-verdict">
          {verdict.kind.note === null ? null : <p className="muted">{verdict.kind.note}</p>}
          <ul>
            {verdict.grants.map((grant) => (
              <li key={grant.id} className={grant.state}>
                {grantReading(grant)}
              </li>
            ))}
          </ul>
          {verdict.ok ? (
            <p className="outcome">Every grant answered. Saving it as {GH_TOKEN_KEY}.</p>
          ) : (
            <p className="refusal">
              Not every grant answered. Fix the token on GitHub and check again, or{" "}
              <button
                type="button"
                className="quiet"
                disabled={running || !looksLikeToken(token)}
                onClick={save}
              >
                save it anyway
              </button>
              .
            </p>
          )}
        </div>
      )}
    </>
  );
}

function ProviderStep({
  install,
  provider,
  providerKey,
  initialised,
  running,
  saved,
  onStart,
}: {
  install: LocalInstall;
  provider: string | null;
  providerKey: string | null;
  initialised: boolean;
  running: boolean;
  saved: boolean;
  onStart: (request: VerbRunRequest) => void;
}) {
  const [value, setValue] = useState("");

  if (saved && providerKey !== null) {
    return (
      <p className="muted">
        <code>{providerKey}</code> is in this install&apos;s <code>.env</code>.
      </p>
    );
  }

  const name =
    provider === "claude"
      ? "Claude Code"
      : provider === "cursor"
        ? "Cursor"
        : provider === "codex"
          ? "Codex"
          : null;

  return (
    <>
      {providerKey === null && name !== null ? (
        <p className="muted">
          The config runs {name}, but computes which env var it reads the key from, so it cannot be
          saved here. Use the form below the steps.
        </p>
      ) : providerKey === null ? (
        <p className="muted">
          {initialised
            ? "The config does not say which agent it runs, so there is no key to ask for here. Set defaultProvider on the config tab, or paste the key in the form below the steps."
            : "Initialise the folder first; the config then says which agent runs."}
        </p>
      ) : (
        <p className="muted">
          The config runs {name}, which reads its key from <code>{providerKey}</code>.
          {provider === "claude"
            ? " A Claude subscription works too: Sign in to Claude, under AI harness below, takes a token instead of a key."
            : ""}
        </p>
      )}
      <form
        className="verbs"
        onSubmit={(event) => {
          event.preventDefault();
          if (providerKey === null) return;
          onStart(secretSetRequest({ install, key: providerKey, value: value.trim() }));
          setValue("");
        }}
      >
        <input
          aria-label="Provider key"
          type="password"
          autoComplete="off"
          placeholder={providerKey ?? "a key"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="submit"
          disabled={running || !initialised || providerKey === null || value.trim().length === 0}
        >
          Save as {providerKey ?? "…"}
        </button>
      </form>
    </>
  );
}

/**
 * The App arm from the setup steps: one App for every repository under one
 * owner, created through GitHub's manifest flow (contracts/github-app.ts). On
 * a workspace it is the step; on a solo install it is the other way, under
 * the token.
 */
function AppStep({
  workspace,
  owner,
  mixed,
  initialised,
  onCreated,
  onCreateApp,
}: {
  workspace: boolean;
  owner: string | null;
  mixed: boolean;
  initialised: boolean;
  onCreated: (app: GithubAppCreated) => void;
  onCreateApp?: (request: GithubAppRequest) => Promise<GithubAppCreated>;
}) {
  const [name, setName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const chosen = name ?? (owner === null ? "" : `phoebe-${owner.toLowerCase()}`);

  function create(): void {
    if (owner === null || onCreateApp === undefined) return;
    setPending(true);
    setTrouble(null);
    onCreateApp({ owner, name: chosen.trim() }).then(
      (created) => {
        setPending(false);
        onCreated(created);
      },
      (error: unknown) => {
        setPending(false);
        setTrouble(error instanceof Error ? error.message : String(error));
      },
    );
  }

  return (
    <div className="app-step">
      {workspace ? (
        <p className="muted">
          A workspace serves several repositories, and the App arm gives it one credential for all
          of them: a GitHub App whose tokens Phoebe mints itself, one per tenant, an hour at a time.
          Phoebe registers it for you through GitHub&apos;s manifest flow with the five permissions
          it needs; GitHub shows one page to confirm, and the App&apos;s id and key come straight
          back into this install&apos;s <code>.env</code>.
        </p>
      ) : (
        <p className="muted">
          Or a GitHub App instead of a token: one credential whose tokens Phoebe mints itself, which
          also serves more repositories later. Phoebe registers it through GitHub&apos;s manifest
          flow; GitHub shows one page to confirm.
        </p>
      )}
      {mixed ? (
        <p className="refusal">
          The tenants span more than one owner, and a GitHub App belongs to one. Give each tenant
          its own <code>GH_TOKEN</code> in its <code>.env</code> instead.
        </p>
      ) : owner === null ? (
        <p className="muted">
          {initialised
            ? "No tenant states a repoSlug yet, so there is no owner to register the App under. Set the slugs first."
            : "Initialise the folder first."}
        </p>
      ) : (
        <form
          className="verbs"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <input
            aria-label="GitHub App name"
            className="mono"
            value={chosen}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            disabled={
              pending || !initialised || onCreateApp === undefined || chosen.trim().length === 0
            }
          >
            {pending ? "Waiting for GitHub…" : `Create a GitHub App under ${owner}`}
          </button>
        </form>
      )}
      {pending ? (
        <p className="muted">
          A browser tab opened on GitHub. Confirm the App there; this step moves on when GitHub
          answers. App names are unique across GitHub, so a name that is taken comes back as a
          refusal to change here.
        </p>
      ) : null}
      {trouble === null ? null : <p className="refusal">The App was not created: {trouble}</p>}
    </div>
  );
}

/** The step once the App exists: what is in the .env, and the one thing left on GitHub. */
function AppCreated({ app }: { app: GithubAppCreated }) {
  return (
    <>
      <p className="muted">
        <code>{app.name}</code> is registered under {app.owner} as App {app.id}. Its id and private
        key are in <code>{app.envFile}</code> as <code>{GH_APP_ID_KEY}</code> and{" "}
        <code>GH_APP_PRIVATE_KEY</code>.
      </p>
      <p>
        <a href={app.installUrl}>Install {app.name} on the repositories Phoebe serves</a>, and only
        those. Phoebe mints a token per tenant from the installation.
      </p>
    </>
  );
}
