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

import { useEffect, useRef, useState } from "react";
import { CANCELLABLE_VERBS } from "phoebe-agent/contracts";
import type {
  CompanionEnvironment,
  DesktopBridge,
  LocalInstall,
  LocalReportEvent,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { DeploymentTabPanel } from "./deployment-tabs.tsx";
import {
  applyRunExit,
  applyRunLine,
  dockerReading,
  landingTab,
  localConfig,
  localConnection,
  offeredVerbs,
  outcomeReading,
  renderableReport,
  versionReading,
} from "./local-install.ts";
import { readReport } from "./report.ts";
import { DEPLOYMENT_TABS, tabHasContent, type DeploymentTab } from "./tabs.ts";

export function InstallPage({
  install,
  bridge,
  report,
  now,
  onForget,
}: {
  install: LocalInstall;
  bridge: DesktopBridge;
  /** The last read main emitted for this install, or null before the first. */
  report: LocalReportEvent | null;
  now: Date;
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

  function start(request: VerbRunRequest): void {
    setTrouble(null);
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
  // A running install's tabs are live while its first read is in flight. The
  // four that need a report are closed only when there is no container behind
  // them, which is the state #526 wrote the rule for.
  const available = {
    report: reading.kind === "read" || install.state === "running",
    config: config !== null,
  };

  return (
    <main className="main install-tab">
      <h1>{install.name}</h1>
      <p className="muted mono">{install.dir}</p>

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
          onStart={start}
          onForget={onForget}
          onCancel={(runId) => void bridge.runs.cancel(runId).catch(() => {})}
        />
      ) : (
        <>
          {install.state === "running" ? null : (
            // The pointer #526 asks for, on the page rather than inside one tab:
            // a stopped install lands here, and the button that changes that is
            // one tab away.
            <p className="muted">
              Nothing is running, so config is the only tab with anything in it.{" "}
              <button type="button" className="quiet" onClick={() => setTab("install")}>
                Go to the install tab
              </button>
            </p>
          )}
          <DeploymentTabPanel
            tab={tab}
            reading={reading}
            connection={localConnection(install)}
            config={config}
            now={now}
            empty={<NoReport install={install} onOpenInstall={() => setTab("install")} />}
          />
        </>
      )}
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
  onOpenInstall,
}: {
  install: LocalInstall;
  onOpenInstall: () => void;
}) {
  if (install.state === "running") {
    return <p className="muted">Reading this install&apos;s report…</p>;
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
  onStart,
  onForget,
  onCancel,
}: {
  install: LocalInstall;
  environment: CompanionEnvironment | null;
  run: VerbRun | null;
  running: boolean;
  trouble: string | null;
  onStart: (request: VerbRunRequest) => void;
  onForget: (dir: string) => void;
  onCancel: (runId: string) => void;
}) {
  const offered = offeredVerbs(install);

  return (
    <>
      <section>
        <h2>Docker</h2>
        <DockerCheck environment={environment} />
      </section>

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
          <button type="button" className="quiet" onClick={() => onForget(install.dir)}>
            Forget
          </button>
        </div>
        <Versions install={install} environment={environment} />
        <p className="muted">
          Forgetting removes this install from the companion. Nothing on disk is deleted.
        </p>
        {trouble === null ? null : <p className="refusal">{trouble}</p>}
      </section>

      <section>
        <h2>Output</h2>
        <RunOutput run={run} onCancel={onCancel} />
      </section>
    </>
  );
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
