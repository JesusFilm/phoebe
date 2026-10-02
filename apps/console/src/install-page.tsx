// A local install's page: the five tabs every deployment has, and the **install
// tab** beside them (#526, #522 §6).
//
// The five are the same components a remote deployment's page renders, fed by
// the same `report` event — main's local read loop execs `status --json` in the
// container and emits what the relay's stream would have carried (#556). So
// nothing under a tab knows which arm it is on, and the one place the arm shows
// is the overview's connection card, which this page builds.
//
// The sixth is the one no remote deployment has: the folder taken from nothing
// to running with buttons. Check Docker, init, start, stop, ask upgrade where
// things stand, and watch the output as it happens.
//
// What a stopped install shows is a decision, not a fallback (#526): config from
// the file, and four tabs that say they need a running container. The window may
// still be holding the last report the loop read before the container stopped —
// it is not rendered. A report is a description of a running deployment, and one
// with an age on it beside a container that is down is two contradicting facts on
// one page.
//
// The versions sit in the same section as the buttons, because they are a reason
// to press one. The local arm **reports and never refuses** (#525 §6): the
// container's pinned phoebe-agent beside the companion's own version, a sentence
// when they differ, and every verb still offered either way. The relay arm has a
// refusal in it (relay-version.ts) and this one deliberately does not — the
// companion drives this install, it does not have to agree with it.
//
// Every button is a verb run. The page starts one, then only applies the events
// main sends it; the lines on screen are main's buffer, which is why reopening
// the window mid-upgrade rejoins the same run rather than showing nothing.
//
// The two writes are runs too (#557). `config set` sits under the config tab,
// which is the one tab a stopped install keeps, and carries the fingerprint the
// tab is showing — so an edit composed against a config a terminal has since
// changed is refused rather than applied blind. `secret set` sits on the install
// tab, because the writer it reaches depends on whether a container is up and the
// one case that has no container is the first `GH_TOKEN` (#527 §8).
//
// **Neither goes near the relay.** A local install's writes run against this
// machine even when it is also paired, so nothing here builds an envelope and
// nothing here signs in. Both forms say so, because "this went straight to the
// folder" and "this was sealed and sent to a server" are different things to
// have done with a secret.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CANCELLABLE_VERBS } from "phoebe-agent/contracts";
import type {
  CompanionEnvironment,
  DesktopBridge,
  EditReceipt,
  LocalInstall,
  LocalReportEvent,
  SecretSetOutcome,
  VerbRun,
  VerbRunRequest,
  InstallPatch,
} from "phoebe-agent/contracts";
import { DeploymentTabPanel, ReceiptPanel } from "./deployment-tabs.tsx";
import {
  applyRunExit,
  applyRunLine,
  configSetRequest,
  dockerReading,
  landingTab,
  localConfig,
  tenantConfigs,
  type TenantConfigReading,
  localConnection,
  offeredVerbs,
  outcomeReading,
  pairReading,
  type PairReading,
  renderableReport,
  secretSetReading,
  secretSetRequest,
  secretWriterReading,
  versionReading,
} from "./local-install.ts";
import { TerminalSquare } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ProjectSettings } from "./project-settings.tsx";
import { readReport } from "./report.ts";
import { DEPLOYMENT_TABS, tabHasContent, type ConfigReading, type DeploymentTab } from "./tabs.ts";

export function InstallPage({
  install,
  bridge,
  report,
  now,
  signedIn,
  paired,
  onConsole,
  onUpdate,
  onForget,
}: {
  install: LocalInstall;
  bridge: DesktopBridge;
  /** The last read main emitted for this install, or null before the first. */
  report: LocalReportEvent | null;
  now: Date;
  /** Whether the companion holds a relay session — what pairing mints on (#558). */
  signedIn: boolean;
  /** Whether this install is already a deployment on that relay. */
  paired: boolean;
  /** Back to the console (console-view.tsx), the view the rail opens. */
  onConsole?: () => void;
  /** Save a change to the install's own settings (project-settings.tsx). */
  onUpdate: (dir: string, patch: InstallPatch) => Promise<void>;
  onForget: (dir: string) => void;
}) {
  const [tab, setTab] = useState<DeploymentTab | "install">(() => landingTab(install));
  const [environment, setEnvironment] = useState<CompanionEnvironment | null>(null);
  const [run, setRun] = useState<VerbRun | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  // The run is main's, so the page reads it rather than owning it. Reading on
  // mount is what makes a reload rejoin a run in flight (#527 §13).
  useEffect(() => {
    let live = true;
    bridge.runs.current(install.dir).then(
      (current) => {
        if (live) setRun(current);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, install.dir]);

  useEffect(() => {
    const unsubscribeLines = bridge.runs.lines((line) => {
      setRun((current) => applyRunLine(current, line));
    });
    const unsubscribeExits = bridge.runs.exits((exit) => {
      setRun((current) => applyRunExit(current, exit));
    });
    return () => {
      unsubscribeLines();
      unsubscribeExits();
    };
  }, [bridge]);

  useEffect(() => {
    let live = true;
    bridge.environment().then(
      (probed) => {
        if (live) setEnvironment(probed);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, run?.exit]);

  const running = run !== null && run.exit === undefined;

  // Which child the last `config set` named, so its receipt lands under that
  // child's form and not under the root's as well.
  const [editedTenant, setEditedTenant] = useState<string | null>(null);
  function start(request: VerbRunRequest): void {
    setTrouble(null);
    if (request.verb === "config set") setEditedTenant(request.tenant ?? null);
    bridge.runs.start(request).then(
      (runId) => {
        // A fresh record rather than a refetch: the first lines may already be
        // on their way, and applying them to a stale run would drop them.
        setRun({
          runId,
          install: install.dir,
          verb: request.verb,
          startedAt: new Date().toISOString(),
          lines: [],
        });
      },
      (error: unknown) => setTrouble(refusalText(error)),
    );
  }

  // The rule the whole stopped-install decision hangs off: what may be drawn is
  // not what was last received.
  const reading = readReport(renderableReport(install, report));
  const config = localConfig(report);
  const tenants = tenantConfigs(report);
  // A running install's tabs are live while its first read is in flight. The
  // four that need a report are closed only when there is no container behind
  // them, which is the state #526 wrote the rule for.
  const available = {
    report: reading.kind === "read" || install.state === "running",
    config: config !== null,
  };
  const pairing = pairReading(install, { signedIn, paired });

  return (
    <main className="main install-tab">
      <div className="page-body">
        <div className="install-title">
          <h1>{install.name}</h1>
          {onConsole === undefined ? null : (
            <Button
              variant="ghost"
              size="icon-xs"
              className="console-open"
              title="Open the console"
              aria-label="Open the console"
              onClick={onConsole}
            >
              <TerminalSquare aria-hidden="true" />
            </Button>
          )}
        </div>
        {install.deploymentDir === undefined ? null : (
          <p className="muted">
            The deployment lives in <span className="mono">{install.deploymentDir}/</span> under
            this folder: its config, its <span className="mono">.env</span> and its container. The
            folder&apos;s own config is the entry a workspace above it reads.
          </p>
        )}

        <ProjectSettings
          install={install}
          onUpdate={(patch) => onUpdate(install.dir, patch)}
          onPickLocation={() => bridge.installs.pick(install.wsl === undefined ? undefined : "wsl")}
        />

        <nav className="tabs" aria-label="This install">
          <button
            type="button"
            className={`tab${tab === "install" ? " current" : ""}`}
            {...(tab === "install" ? { "aria-current": "page" as const } : {})}
            onClick={() => setTab("install")}
          >
            install
          </button>
          {DEPLOYMENT_TABS.map((name) => {
            const enabled = tabHasContent(name, available);
            return (
              <button
                key={name}
                type="button"
                className={`tab${tab === name ? " current" : ""}`}
                disabled={!enabled}
                {...(tab === name ? { "aria-current": "page" as const } : {})}
                {...(enabled ? {} : { title: "Needs a running container." })}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            );
          })}
        </nav>

        {tab === "install" ? (
          <InstallTab
            install={install}
            environment={environment}
            run={run}
            running={running}
            trouble={trouble}
            pairing={pairing}
            onStart={start}
            onForget={onForget}
            onCancel={(runId) => void bridge.runs.cancel(runId).catch(() => {})}
          />
        ) : (
          <>
            <DeploymentTabPanel
              tab={tab}
              reading={reading}
              connection={localConnection(install)}
              config={config}
              now={now}
              empty={
                <NoReport
                  install={install}
                  reason={
                    report !== null && report.install === install.dir
                      ? (report.reason ?? null)
                      : null
                  }
                  onOpenInstall={() => setTab("install")}
                />
              }
              writes={{
                config: (
                  <>
                    <ConfigEditForm
                      install={install}
                      config={config}
                      running={running}
                      receipt={editedTenant === null ? receiptOfRun(run) : null}
                      onStart={start}
                    />
                    <TenantConfigs
                      install={install}
                      tenants={tenants}
                      running={running}
                      receipt={receiptOfRun(run)}
                      editedTenant={editedTenant}
                      onStart={start}
                    />
                  </>
                ),
                secrets: (
                  <p className="muted">
                    Setting one on a local install is on the install tab, where it is reachable with
                    nothing running — which is where the first <code>GH_TOKEN</code> is typed.{" "}
                    <button type="button" className="quiet" onClick={() => setTab("install")}>
                      Go to the install tab
                    </button>
                  </p>
                ),
              }}
            />
          </>
        )}
      </div>
    </main>
  );
}

/**
 * What the four report-fed tabs say with nothing to draw.
 *
 * Three different nothings, because they are three different things to do. A
 * running install is mid-read and the operator waits. A stopped or
 * uninitialised one needs a button pressed, and the pointer #526 asks for says
 * which tab that button is on.
 */
function NoReport({
  install,
  reason,
  onOpenInstall,
}: {
  install: LocalInstall;
  /** Why the last read came back with no report, when it did. */
  reason: string | null;
  onOpenInstall: () => void;
}) {
  if (install.state === "running") {
    // A read that failed says why; "reading…" is only true before the first
    // answer. The loop keeps asking, so a sentence here is not the end of it.
    return reason === null ? (
      <p className="muted">Reading this install&apos;s report…</p>
    ) : (
      <p className="refusal">The container answered with no report: {reason}</p>
    );
  }
  return (
    <>
      <p className="muted">
        {install.state === "not-initialised"
          ? "This folder has no Phoebe install in it yet, so there is no container to read."
          : "This tab reads a running deployment's report, and this install's container is not up."}
      </p>
      <p>
        <button type="button" className="quiet" onClick={onOpenInstall}>
          Go to the install tab
        </button>
      </p>
    </>
  );
}

/**
 * The install tab: Docker, the verbs this install can be asked for, the output.
 *
 * Exported because it is the tab with the buttons on it, and a test that asks
 * which buttons an install is offered should not have to click its way to them.
 */
export function InstallTab({
  install,
  environment,
  run,
  running,
  trouble,
  pairing,
  onStart,
  onForget,
  onCancel,
}: {
  install: LocalInstall;
  environment: CompanionEnvironment | null;
  run: VerbRun | null;
  running: boolean;
  trouble: string | null;
  /** Where this install stands with the relay the companion is signed in to (#558). */
  pairing: PairReading;
  onStart: (request: VerbRunRequest) => void;
  onForget: (dir: string) => void;
  onCancel: (runId: string) => void;
}) {
  const offered = offeredVerbs(install);

  return (
    <>
      {install.wsl === undefined ? (
        <section>
          <h2>Docker</h2>
          <DockerCheck environment={environment} />
        </section>
      ) : null}

      <section>
        <h2>This install</h2>
        <p>
          <span className={`mark ${install.state}`} aria-hidden="true" />
          {install.state === "running"
            ? "The container is up."
            : install.state === "stopped"
              ? "The container is not up."
              : "This folder has no Phoebe install in it yet."}
          {install.detail === undefined ? null : <span className="muted"> — {install.detail}</span>}
        </p>
        <div className="verbs">
          {offered.init ? (
            <button
              type="button"
              disabled={running}
              onClick={() => onStart({ install: install.dir, verb: "init" })}
            >
              Init
            </button>
          ) : null}
          {offered.start ? (
            <button
              type="button"
              disabled={running}
              onClick={() => onStart({ install: install.dir, verb: "start" })}
            >
              Start
            </button>
          ) : null}
          {offered.stop ? (
            <button
              type="button"
              disabled={running}
              onClick={() => onStart({ install: install.dir, verb: "stop" })}
            >
              Stop
            </button>
          ) : null}
          {offered.upgrade ? (
            <button
              type="button"
              disabled={running}
              onClick={() => onStart({ install: install.dir, verb: "upgrade", check: true })}
            >
              Check for upgrades
            </button>
          ) : null}
          {offered.doctor ? (
            <button
              type="button"
              disabled={running}
              onClick={() => onStart({ install: install.dir, verb: "doctor" })}
            >
              Doctor
            </button>
          ) : null}
          {pairing.kind === "paired" ? null : (
            <button
              type="button"
              disabled={running || pairing.kind === "blocked"}
              {...(pairing.kind === "blocked" ? { title: pairing.reason } : {})}
              onClick={() => onStart({ install: install.dir, verb: "pair" })}
            >
              Pair with the relay
            </button>
          )}
          <button type="button" className="quiet" onClick={() => onForget(install.dir)}>
            Forget
          </button>
        </div>
        <Versions install={install} environment={environment} />
        <p className="muted">
          {pairing.kind === "paired"
            ? "Paired — this install is the deployment the relay knows, so the rail draws it here and not under Relay."
            : pairing.kind === "blocked"
              ? pairing.reason
              : "Pairing mints a token on the relay, points this install's config at it and nudges the container. The token never leaves this machine in a line you can read."}
        </p>
        <p className="muted">
          Forgetting removes this install from the companion. Nothing on disk is deleted.
        </p>
        {trouble === null ? null : <p className="refusal">{trouble}</p>}
      </section>

      <SecretSetForm install={install} running={running} run={run} onStart={onStart} />

      <section>
        <h2>Output</h2>
        <RunOutput run={run} onCancel={onCancel} />
      </section>
    </>
  );
}

/**
 * One field of the config, changed in place (#503, #527 §11).
 *
 * The fingerprint is not an input. It is whatever the tab above is showing, sent
 * with the edit, and the writer refuses `stale` when the file has moved since —
 * which is the whole of the concurrency story on both arms. There is nothing for
 * an operator to copy and nothing for them to get wrong.
 *
 * The value is typed as a JSON literal rather than guessed at. A config leaf is
 * a literal, and `"main"` and `main` are a string either way while `300000` and
 * `"300000"` are not — a form that decided for the operator would be the one
 * place a number quietly became a string.
 */
export function ConfigEditForm({
  install,
  config,
  running,
  receipt,
  onStart,
  tenant,
  heading = "Change one field",
}: {
  install: LocalInstall;
  config: ConfigReading | null;
  running: boolean;
  /** The receipt the last `config set` on this install answered with, if any. */
  receipt: EditReceipt | null;
  onStart: (request: VerbRunRequest) => void;
  /** A workspace child's folder: the edit goes to its config rather than the root's. */
  tenant?: string;
  /** The heading over the form; the root's says which file below it. */
  heading?: string;
}) {
  const [field, setField] = useState("");
  const [literal, setLiteral] = useState("");
  const [unreadable, setUnreadable] = useState<string | null>(null);

  if (config === null || config.kind === "absent") return null;
  // Held in a binding a closure can narrow: the fingerprint the form sends is
  // the one this tab is showing, and nothing else.
  const file = config;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    let request: VerbRunRequest;
    try {
      request = configSetRequest({
        install,
        config: file,
        path: field,
        literal,
        ...(tenant === undefined ? {} : { tenant }),
      });
    } catch (error) {
      setUnreadable(error instanceof Error ? error.message : String(error));
      return;
    }
    setUnreadable(null);
    onStart(request);
  }

  return (
    <>
      <h2>{heading}</h2>
      <p className="muted">
        Written straight to <span className="mono">{file.path}</span> on this machine. No relay is
        involved, and the edit checks itself against the fingerprint above — if the file has moved
        since this tab read it, the edit is refused and says what to type instead.
      </p>
      <form className="verbs" onSubmit={submit}>
        <input
          aria-label="Config path"
          className="mono"
          placeholder="pipelines.work.pollIntervalMs"
          value={field}
          onChange={(event) => setField(event.target.value)}
        />
        <input
          aria-label="Value, as a JSON literal"
          className="mono"
          placeholder='300000, "main", true, null'
          value={literal}
          onChange={(event) => setLiteral(event.target.value)}
        />
        <button type="submit" disabled={running || field.trim().length === 0}>
          Set
        </button>
      </form>
      {unreadable === null ? null : <p className="refusal">{unreadable}</p>}
      {receipt === null ? null : <ReceiptPanel receipt={receipt} />}
    </>
  );
}

/**
 * One secret, set on this install (#527 §7, §8).
 *
 * The value lives in this component's state and nowhere else: the field clears
 * on submit, nothing renders it back, and main holds it for the run and no
 * longer. The form also says which of the two writers will take it, because that
 * is a reading of the install's state rather than a choice, and an operator is
 * entitled to know where a token is about to land before they paste one.
 */
export function SecretSetForm({
  install,
  running,
  run,
  onStart,
}: {
  install: LocalInstall;
  running: boolean;
  run: VerbRun | null;
  onStart: (request: VerbRunRequest) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [tenant, setTenant] = useState("");
  const outcome = secretOutcomeOfRun(run);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onStart(secretSetRequest({ install, key, value, tenant }));
    // Emptied here rather than after the exit: the run has the value now, and a
    // box still holding a token is a box that can be read over a shoulder.
    setValue("");
  }

  return (
    <section>
      <h2>Set a secret</h2>
      <p className="muted">{secretWriterReading(install)}</p>
      <p className="muted">
        The value goes straight from this window to this machine. Nothing is sealed to anybody and
        nothing is sent to a relay, even if this install is paired — that envelope exists for a
        deployment a console can only reach through a server, and this one is a folder.
      </p>
      <form className="verbs" onSubmit={submit}>
        <input
          aria-label="Secret key"
          className="mono"
          placeholder="GH_TOKEN"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <input
          aria-label="Secret value"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <input
          aria-label="Tenant, on a workspace"
          className="mono"
          placeholder="owner/repo (a workspace only)"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
        <button type="submit" disabled={running || key.trim().length === 0 || value.length === 0}>
          Set
        </button>
      </form>
      {outcome === null ? null : <p className="outcome">{secretSetReading(outcome)}</p>}
    </section>
  );
}

/** The last run's receipt, when the last run was a `config set` that finished. */
function receiptOfRun(run: VerbRun | null): EditReceipt | null {
  const outcome = run?.exit?.outcome;
  return outcome?.verb === "config set" ? outcome.outcome : null;
}

/** The same, for `secret set`. */
function secretOutcomeOfRun(run: VerbRun | null): SecretSetOutcome | null {
  const outcome = run?.exit?.outcome;
  return outcome?.verb === "secret set" ? outcome.outcome : null;
}

/** The two versions, stated. Nothing on this page turns on their difference. */
function Versions({
  install,
  environment,
}: {
  install: LocalInstall;
  environment: CompanionEnvironment | null;
}) {
  const reading = versionReading(install, environment);
  return (
    <p className="muted">
      {reading.text}
      {reading.note === null ? null : ` — ${reading.note}`}
    </p>
  );
}

/** Docker as the companion found it — checked, never installed (#522 §2). */
function DockerCheck({ environment }: { environment: CompanionEnvironment | null }) {
  const reading = dockerReading(environment);
  switch (reading.kind) {
    case "probing":
      return <p className="muted">Looking for Docker…</p>;
    case "missing":
      return (
        <p className="refusal">
          <code>docker</code> is not on this machine&apos;s PATH. Phoebe drives Docker Compose and
          does not install it —{" "}
          <a href="https://docs.docker.com/get-started/get-docker/">get Docker</a>, then reopen this
          tab.
        </p>
      );
    case "daemon-down":
      return (
        <p className="refusal">
          Docker is installed but its daemon did not answer. Start Docker, then reopen this tab.
        </p>
      );
    case "ready":
      return <p className="muted">{reading.text}</p>;
  }
}

/** The verb run's lines while it runs, and what it decided when it ends. */
function RunOutput({ run, onCancel }: { run: VerbRun | null; onCancel: (runId: string) => void }) {
  const tail = useRef<HTMLDivElement>(null);

  // Follow the tail. An operator watching a start does not want to scroll.
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [run?.lines.length]);

  if (run === null) {
    return <p className="muted">Nothing has run on this install yet.</p>;
  }

  const finished = run.exit !== undefined;
  const cancellable = !finished && CANCELLABLE_VERBS.includes(run.verb);

  return (
    <>
      <p className="muted">
        <code>phoebe {run.verb}</code> ·{" "}
        {finished ? (run.exit!.code === 0 ? "finished" : `exited ${run.exit!.code}`) : "running…"}
        {cancellable ? (
          <>
            {" "}
            <button type="button" className="quiet" onClick={() => onCancel(run.runId)}>
              Cancel
            </button>
          </>
        ) : null}
      </p>
      <div className="run-lines mono" ref={tail} aria-label="Verb output">
        {run.lines.map((line, index) => (
          <div key={index} className={line.stream}>
            {line.line}
          </div>
        ))}
      </div>
      {run.exit?.outcome === undefined ? null : (
        <p className={run.exit.code === 0 ? "outcome" : "refusal"}>
          {outcomeReading(run.exit.outcome)}
        </p>
      )}
    </>
  );
}

/**
 * A refusal's own words. Every bridge call rejects with `{ code, message,
 * instruction? }` (#527 §16), and the instruction is the thing the operator can
 * run by hand — so it goes on screen beside the message, not in a console log.
 */
function refusalText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const instruction = (error as { instruction?: string }).instruction;
  return instruction === undefined ? error.message : `${error.message} — ${instruction}`;
}

/**
 * A workspace's tenants, each with its own config space under the root's: the
 * file as the folder holds it, and the same one-field edit form pointed at it.
 * The receipt is shown under the tenant the last run named, not under all of
 * them.
 */
function TenantConfigs({
  install,
  tenants,
  running,
  receipt,
  editedTenant,
  onStart,
}: {
  install: LocalInstall;
  tenants: TenantConfigReading[];
  running: boolean;
  receipt: EditReceipt | null;
  /** The child the last `config set` named, so its receipt lands under it alone. */
  editedTenant: string | null;
  onStart: (request: VerbRunRequest) => void;
}) {
  if (tenants.length === 0) return null;
  return (
    <section className="tenant-configs" aria-label="Tenants">
      <h2>Tenants</h2>
      <p className="muted">
        Each child of this workspace keeps its own <code>phoebe.config.ts</code>. The root above
        names the fleet; these say what each member does.
      </p>
      {tenants.map((tenant) => (
        <details key={tenant.dir} className="tenant-config" open>
          <summary>
            <span className="tenant-label">{tenant.label}</span>
            <span className="muted mono">{tenant.config.path}</span>
          </summary>
          {tenant.config.kind === "absent" ? (
            <p className="muted">
              No <code>phoebe.config.ts</code> in this folder.
            </p>
          ) : (
            <>
              <p className="muted">{tenant.config.fingerprint}</p>
              <pre className="config mono">{tenant.config.text}</pre>
              <ConfigEditForm
                install={install}
                config={tenant.config}
                running={running}
                receipt={editedTenant === tenant.dir ? receipt : null}
                onStart={onStart}
                tenant={tenant.dir}
                heading={`Change one field in ${tenant.label}`}
              />
            </>
          )}
        </details>
      ))}
    </section>
  );
}
