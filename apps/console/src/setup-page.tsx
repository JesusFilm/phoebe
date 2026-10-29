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
// button spins from the click until the probe answers, the output streams
// below it, and the moment Docker is running the page gives way to home
// (app.tsx) — there is nothing left here to read. "Continue without Docker"
// is there until then: a machine that only watches deployments elsewhere has
// no use for a daemon.

import type {
  BootstrapPlan,
  BootstrapRun,
  BootstrapStep,
  BootstrapTool,
  CompanionEnvironment,
} from "phoebe-agent/contracts";
import { Spinner } from "~/components/ui/spinner";
import { dockerReading } from "./local-install.ts";
import { HOME_HREF } from "./route.ts";

/** The button for a step, by what it does. */
function stepLabel(step: { tool: BootstrapTool; need: BootstrapStep["need"] }): string {
  const tool = step.tool === "docker" ? "Docker" : step.tool;
  return `${step.need === "install" ? "Install" : "Start"} ${tool}`;
}

/** The same button while the step is under way. */
function pendingLabel(step: { tool: BootstrapTool; need: BootstrapStep["need"] }): string {
  const tool = step.tool === "docker" ? "Docker" : step.tool;
  return `${step.need === "install" ? "Installing" : "Starting"} ${tool}…`;
}

/**
 * Is this step still being waited on? From the click until the command
 * exits, and after a clean exit until the probe sees what the step was for:
 * the daemon after a start, the binary after an install. A step that failed,
 * or one main gave up waiting on, is not pending; its button comes back for
 * another go.
 */
export function stepPending(
  step: { tool: BootstrapTool; need: BootstrapStep["need"] },
  run: BootstrapRun | null,
  docker: ReturnType<typeof dockerReading>,
): boolean {
  if (run === null || run.tool !== step.tool || run.need !== step.need) return false;
  if (run.exit === undefined) return true;
  if (run.exit.code !== 0 || run.exit.settled === "timed-out") return false;
  return step.need === "start" ? docker.kind !== "ready" : docker.kind === "missing";
}

/** What to say when the command went fine and Docker still did not answer. */
function timedOutReading(run: BootstrapRun): string {
  return run.need === "start"
    ? "Docker was started, but its engine did not answer within two minutes. Check the Docker Desktop window for what it is doing, then start it again from here. The companion keeps looking while this page is open."
    : "The install finished, but the companion cannot see docker yet. Sign out and back in, or quit and reopen the companion, so it picks up the new PATH.";
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
  const busy = run !== null && run.exit === undefined;

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
          : plan.steps.map((step) => {
              const pending = stepPending(step, run, docker);
              const note = [
                step.elevates ? "The OS asks for permission before this runs." : null,
                step.note,
              ].filter((part) => part !== null);
              return (
                <div key={`${step.tool}:${step.need}`} className="setup-step">
                  <pre className="setup-command">
                    <code>{step.command}</code>
                  </pre>
                  {note.length === 0 ? null : <p className="muted">{note.join(" ")}</p>}
                  <div className="verbs">
                    <button
                      type="button"
                      className={pending ? "pending" : undefined}
                      disabled={onRun === undefined || busy || pending}
                      aria-busy={pending ? true : undefined}
                      onClick={() => onRun?.({ tool: step.tool, need: step.need })}
                    >
                      {pending ? (
                        <>
                          <Spinner
                            className="button-spinner motion-safe:animate-spin motion-reduce:animate-pulse"
                            size={12}
                            strokeWidth={2.25}
                            aria-hidden="true"
                          />
                          {pendingLabel(step)}
                        </>
                      ) : (
                        stepLabel(step)
                      )}
                    </button>
                  </div>
                </div>
              );
            })}

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
            {run.exit === undefined ? null : run.exit.code === 0 ? (
              run.exit.settled === "timed-out" && docker.kind !== "ready" ? (
                <p className="refusal">{timedOutReading(run)}</p>
              ) : null
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

      {docker.kind === "ready" ? null : (
        <div className="verbs">
          <a className="button" href={HOME_HREF}>
            Continue without Docker
          </a>
        </div>
      )}
    </main>
  );
}
