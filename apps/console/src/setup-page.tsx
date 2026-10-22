// The setup page: what this machine needs before a local install can run, and
// the buttons that get it there (`#/setup`).
//
// The companion opens here on launch when Docker is missing or not running,
// the way an app that needs a runtime opens on its first-run screen, and the
// install tab and the home page link here whenever that is still true. There
// is one tool today, Docker; the page is a list so that Tailscale can join it
// with remote access.
//
// Every command is on the page before it runs, with whether the OS will ask
// for permission, because the thing being installed is not Phoebe's. The
// output streams below the button, and the page says "running" the moment the
// probe does. "Continue without Docker" is always there: a machine that only
// watches deployments elsewhere has no use for a daemon.

import type {
  BootstrapPlan,
  BootstrapRun,
  BootstrapStep,
  BootstrapTool,
  CompanionEnvironment,
} from "phoebe-agent/contracts";
import { dockerReading } from "./local-install.ts";
import { HOME_HREF } from "./route.ts";

/** The button for a step, by what it does. */
function stepLabel(step: { tool: BootstrapTool; need: BootstrapStep["need"] }): string {
  const tool = step.tool === "docker" ? "Docker" : step.tool;
  return `${step.need === "install" ? "Install" : "Start"} ${tool}`;
}

export function SetupPage({
  environment,
  plan,
  run,
  onRun,
}: {
  /** What main found on this machine, or null before it answered. */
  environment: CompanionEnvironment | null;
  /** What the companion offers to run, or null before main answered. */
  plan: BootstrapPlan | null;
  /** The step running now or the last one, or null when none has. */
  run: BootstrapRun | null;
  /** Absent in a browser, where nothing can be run. */
  onRun?: (step: { tool: BootstrapTool; need: BootstrapStep["need"] }) => void;
}) {
  const docker = dockerReading(environment);
  const running = run !== null && run.exit === undefined;

  return (
    <main className="main setup-page">
      <h1>Set up this machine</h1>
      <p className="muted">
        Phoebe drives a deployment through Docker Compose, so this machine needs Docker before a
        local install can start. The companion can install or start it from here. Every command is
        shown before it runs, and the OS asks for permission where a step needs it.
      </p>

      <section aria-labelledby="setup-docker">
        <h2 id="setup-docker">Docker</h2>
        {docker.kind === "probing" ? (
          <p className="muted">Looking for Docker…</p>
        ) : docker.kind === "ready" ? (
          <p className="outcome">{docker.text}</p>
        ) : (
          <p className="refusal">
            {docker.kind === "missing"
              ? "Docker is not on this machine."
              : "Docker is installed but its daemon is not running."}
          </p>
        )}

        {docker.kind === "ready" || plan === null
          ? null
          : plan.steps.map((step) => (
              <div key={`${step.tool}:${step.need}`} className="setup-step">
                <pre className="setup-command">
                  <code>{step.command}</code>
                </pre>
                <p className="muted">
                  {step.elevates
                    ? "The OS asks for permission before this runs. "
                    : "No permission prompt. "}
                  {step.note ?? ""}
                </p>
                <div className="verbs">
                  <button
                    type="button"
                    disabled={onRun === undefined || running}
                    onClick={() => onRun?.({ tool: step.tool, need: step.need })}
                  >
                    {stepLabel(step)}
                  </button>
                </div>
              </div>
            ))}

        {docker.kind === "ready" || plan === null
          ? null
          : plan.blocked.map((why) => (
              <p key={`${why.tool}:${why.need}`} className="refusal">
                The companion cannot {why.need} Docker here: {why.reason}.{" "}
                <a href={why.link}>Get Docker</a>, then come back to this page.
              </p>
            ))}

        {run === null ? null : (
          <>
            {/* A launcher like `open -a` prints nothing; an empty box would say otherwise. */}
            {run.lines.length === 0 ? null : (
              <pre className="run-lines" aria-label={`The output of ${stepLabel(run)}`}>
                {run.lines.map((line, index) => (
                  <span key={index} className={line.stream}>
                    {line.line}
                    {"\n"}
                  </span>
                ))}
              </pre>
            )}
            {run.exit === undefined ? (
              <p className="muted">Running {run.command}…</p>
            ) : run.exit.code === 0 ? (
              docker.kind === "ready" ? null : (
                <p className="muted">
                  Done. Waiting for Docker to answer; the line above changes when it does.
                </p>
              )
            ) : (
              <p className="refusal">
                The command exited with{" "}
                {run.exit.code === null ? "no code" : `code ${run.exit.code}`}. The lines above say
                why.
              </p>
            )}
          </>
        )}
      </section>

      <div className="verbs">
        <a className="button" href={HOME_HREF}>
          {docker.kind === "ready" ? "Done" : "Continue without Docker"}
        </a>
      </div>
    </main>
  );
}
