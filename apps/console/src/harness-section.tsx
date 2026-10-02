// The AI harness section: which agent CLI an install's container carries, at
// what version, and the button that moves it.
//
// Opening it reads a file and asks the container, and nothing leaves the
// machine. "Check for updates" is the one thing that asks a registry. An update
// rewrites the pin in `container/Dockerfile` and stops there, because the
// rebuild that puts it in the container takes the deployment down for as long
// as a build takes. That is a second button, and a run with output like any
// other.
//
// A workspace's container is shared, so there is one Dockerfile however many
// tenants there are. A tenant's page shows the harness its own config runs and
// moves the same pin the workspace's page does.

import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBridge,
  HarnessApplyOutcome,
  HarnessName,
  HarnessReport,
  HarnessUpdateOutcome,
  LocalInstall,
  LocalReportEvent,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  applyReading,
  awaitingRebuild,
  engineReading,
  engineStanding,
  harnessReading,
  harnessRows,
  harnessStanding,
  harnessUsers,
  launcherStanding,
  launcherVersionOf,
  needsRebuild,
  phoebeVersions,
  updateReading,
  updateVerb,
  upgradeReading,
  type HarnessRow,
  type PhoebeVersions,
} from "./harness.ts";
import { refusalText } from "./verb-run.ts";

export function HarnessSection({
  install,
  bridge,
  event,
  tenant,
  busy,
  onRebuild,
  run = null,
  onStart,
}: {
  /** The install whose container it is: the workspace, on a tenant's page. */
  install: LocalInstall;
  bridge: DesktopBridge;
  /** The last read main emitted for the install, or null before the first. */
  event: LocalReportEvent | null;
  /** On a tenant's page, the tenant's folder: the list narrows to what it runs. */
  tenant?: string;
  /** A verb is running on the install, so nothing else should start. */
  busy: boolean;
  /** Stop the install if it is up, then start it with a rebuild. */
  onRebuild: () => void;
  /** The install's current or last run: an upgrade's outcome is read off it. */
  run?: VerbRun | null;
  /**
   * Start a run on the install. Given on the install's own page, where Phoebe's
   * launcher and engine are listed above the harnesses and moved by `upgrade`.
   */
  onStart?: (request: VerbRunRequest) => void;
}) {
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [updating, setUpdating] = useState<HarnessName | null>(null);
  const [outcome, setOutcome] = useState<HarnessUpdateOutcome | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [applying, setApplying] = useState<HarnessName | null>(null);
  const [applied, setApplied] = useState<HarnessApplyOutcome | null>(null);

  const check = useCallback(
    (lookUp: boolean) => {
      if (lookUp) setLookingUp(true);
      return bridge.harness
        .check(install.dir, { lookUp })
        .then(
          (found) => {
            setReport(found);
            setTrouble(null);
          },
          (error: unknown) => setTrouble(refusalText(error)),
        )
        .finally(() => {
          if (lookUp) setLookingUp(false);
        });
    },
    [bridge, install.dir],
  );

  // Checked again whenever the pins or the container's state move: an update
  // lands as a fresh read of the install, and so does a hand edit or a rebuild.
  // And when a run ends: an upgrade has moved the launcher's pin, and a rebuild
  // has changed what the container carries.
  const pins = JSON.stringify(event?.directory.harnessPins ?? null);
  const ended = run?.exit === undefined ? null : run.runId;
  useEffect(() => {
    void check(false);
  }, [check, pins, install.state, install.containerVersion, ended]);

  // Put what the Dockerfile pins into the running container, then read it again.
  const apply = useCallback(
    async (harnesses: readonly HarnessName[]): Promise<void> => {
      for (const harness of harnesses) {
        setApplying(harness);
        try {
          setApplied(await bridge.harness.apply(install.dir, harness));
        } catch (error) {
          setApplied({ kind: "refused", harness, why: refusalText(error) });
        }
      }
      setApplying(null);
      await check(false);
    },
    [bridge, install.dir, check],
  );

  const running = install.state === "running";
  const update = (harness: HarnessName, version: string): void => {
    setUpdating(harness);
    setOutcome(null);
    setApplied(null);
    bridge.harness
      .update(install.dir, { harness, version })
      .then(
        (moved) => {
          setOutcome(moved);
          // A running install gets it now, beside the one it has, so no unit
          // in flight is disturbed and the next one starts on the new version.
          if (moved.kind !== "refused" && running) void apply([harness]);
        },
        (error: unknown) =>
          setOutcome({ kind: "refused", harness, why: refusalText(error), instruction: null }),
      )
      .finally(() => setUpdating(null));
  };

  const users = harnessUsers(install, event);
  const only =
    tenant === undefined ? null : (users.find((user) => user.dir === tenant)?.harness ?? null);
  const rows = harnessRows(report, event, users, only);
  // No Dockerfile, no section: a tenant's folder added on its own, or a folder
  // not initialised yet, has no container of its own to speak of.
  if (
    event?.directory.harnessPins === undefined &&
    (report === null || report.dockerfile === null)
  ) {
    return null;
  }

  return (
    <>
      {onStart === undefined || tenant !== undefined ? null : (
        <PhoebePanel
          install={install}
          versions={phoebeVersions(install, event, report)}
          containerAsked={report?.containerAsked ?? false}
          run={run}
          lookingUp={lookingUp}
          busy={busy}
          onLookUp={() => void check(true)}
          onUpgrade={(target, ref) =>
            onStart({ install: install.dir, verb: "upgrade", check: false, target, ref })
          }
          onRebuild={onRebuild}
        />
      )}
      <HarnessPanel
        install={install}
        rows={rows}
        shared={tenant !== undefined}
        containerAsked={report?.containerAsked ?? false}
        latestAt={report?.latestAt ?? null}
        lookingUp={lookingUp}
        updating={updating}
        outcome={outcome}
        applying={applying}
        applied={applied}
        trouble={trouble}
        busy={busy}
        onLookUp={() => void check(true)}
        onUpdate={update}
        onApply={(harnesses) => void apply(harnesses)}
        onRebuild={onRebuild}
      />
    </>
  );
}

/**
 * Phoebe's own two versions, above the harnesses it runs.
 *
 * The launcher is pinned in the Dockerfile like a harness, and the engine is a
 * ref in the config. Both are moved by an `upgrade` run rather than by an edit
 * from here, because an upgrade is more than the edit: the engine's migrations
 * run with it, and the run's output is where a refusal explains itself.
 */
export function PhoebePanel({
  install,
  versions,
  containerAsked,
  run,
  lookingUp,
  busy,
  onLookUp,
  onUpgrade,
  onRebuild,
}: {
  install: LocalInstall;
  versions: PhoebeVersions;
  containerAsked: boolean;
  run: VerbRun | null;
  lookingUp: boolean;
  busy: boolean;
  onLookUp: () => void;
  onUpgrade: (target: "cli" | "engine", ref: string) => void;
  onRebuild: () => void;
}) {
  const { launcher, engine } = versions;
  if (launcher === null && engine === null) return null;
  const upgrading = run !== null && run.verb === "upgrade" && run.exit === undefined;
  const outcome = run?.exit?.outcome;
  const said = outcome?.verb === "upgrade" ? upgradeReading(outcome.outcome) : null;
  const failed =
    run !== null && run.verb === "upgrade" && run.exit !== undefined && outcome === undefined;
  const stale = launcher !== null && needsRebuild(launcher);
  const launcherStand = launcher === null ? null : launcherStanding(launcher);
  const engineStand = engine === null ? null : engineStanding(engine);

  return (
    <section className="harness" aria-label="Phoebe versions">
      <h2>Phoebe</h2>
      <p className="muted">
        Phoebe&apos;s own two versions. The launcher is the{" "}
        <span className="mono">phoebe-agent</span> package the image installs and boots from. The
        engine is the ref the config names, which the launcher checks out and runs.
      </p>
      <ul className="harness-list">
        {launcher === null ? null : (
          <li className="harness-row">
            <div className="harness-what">
              <div className="harness-name">
                <strong>Launcher</strong>
                <span className="chip">phoebe-agent</span>
                {launcherStand === null ? null : (
                  <span className={`chip check ${launcherStand.tone}`}>{launcherStand.text}</span>
                )}
              </div>
              <div className="muted">{harnessReading(launcher, containerAsked)}</div>
              {launcher.pin.kind === "unpinned" ? (
                <div className="muted">
                  The Dockerfile names no version, so each build installs the newest. Rebuild to
                  take it.
                </div>
              ) : null}
            </div>
            {launcher.pin.kind !== "pinned" ? null : (
              <MoveField
                label="Version of the launcher"
                offered={launcher.latest ?? ""}
                placeholder="version"
                current={launcher.pin.version}
                parse={launcherVersionOf}
                verb="Upgrade"
                busy={busy}
                onMove={(version) => onUpgrade("cli", `v${version}`)}
              />
            )}
          </li>
        )}
        {engine === null ? null : (
          <li className="harness-row">
            <div className="harness-what">
              <div className="harness-name">
                <strong>Engine</strong>
                <span className="chip">engine.ref</span>
                {engineStand === null ? null : (
                  <span className={`chip check ${engineStand.tone}`}>{engineStand.text}</span>
                )}
              </div>
              <div className="muted">{engineReading(engine)}</div>
              {engine.source === "github" ? (
                <div className="muted">
                  A running install picks a new engine up by itself, and its migrations run with the
                  move.
                </div>
              ) : null}
            </div>
            {engine.source !== "github" ? null : (
              <MoveField
                label="Ref of the engine"
                offered={engine.release ? (engine.latest ?? "") : ""}
                placeholder="tag, branch or commit"
                current={engine.ref}
                parse={(typed) => (/^[\w./-]+$/.test(typed.trim()) ? typed.trim() : null)}
                verb="Move"
                busy={busy}
                onMove={(ref) => onUpgrade("engine", ref)}
              />
            )}
          </li>
        )}
      </ul>
      <div className="verbs">
        <Button size="sm" variant="outline" disabled={lookingUp} onClick={onLookUp}>
          {lookingUp ? "Checking…" : "Check for updates"}
        </Button>
        {!stale && said?.rebuild !== true ? null : (
          <Button size="sm" disabled={busy} onClick={onRebuild}>
            {install.state === "running" ? "Rebuild and restart" : "Rebuild and start"}
          </Button>
        )}
      </div>
      {stale && said?.rebuild !== true && launcher !== null && launcher.pin.kind === "pinned" ? (
        <p className="warning">
          The Dockerfile pins the launcher at {launcher.pin.version} and the container has{" "}
          {launcher.running}. Rebuild to pick the pin up.
        </p>
      ) : null}
      {upgrading ? (
        <p className="muted">Upgrading. The console&apos;s cli tab has the run.</p>
      ) : said !== null ? (
        <p className={said.ok ? "receipt written" : "refusal"} role="status">
          {said.text}
        </p>
      ) : failed ? (
        <p className="refusal">The upgrade did not finish. The console&apos;s cli tab says why.</p>
      ) : null}
    </section>
  );
}

/** A version field and the button that moves to what is in it. */
function MoveField({
  label,
  offered,
  placeholder,
  current,
  parse,
  verb,
  busy,
  onMove,
}: {
  label: string;
  /** What the field holds until something is typed: the latest known, or nothing. */
  offered: string;
  placeholder: string;
  /** Where it stands now; moving to the same place is not offered. */
  current: string;
  /** What was typed, as the value to move to, or null when it is not one. */
  parse: (typed: string) => string | null;
  verb: string;
  busy: boolean;
  onMove: (value: string) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const draft = typed ?? offered;
  const value = parse(draft);
  return (
    <div className="harness-move">
      <Input
        size="sm"
        className="harness-version mono"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setTyped(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || value === null || value === current || `v${value}` === current}
        onClick={() => value !== null && onMove(value)}
      >
        {verb}
      </Button>
    </div>
  );
}

/** The section as drawn, with everything it shows handed in. */
export function HarnessPanel({
  install,
  rows,
  shared,
  containerAsked,
  latestAt,
  lookingUp,
  updating,
  outcome,
  applying = null,
  applied = null,
  trouble,
  busy,
  onLookUp,
  onUpdate,
  onApply,
  onRebuild,
}: {
  install: LocalInstall;
  rows: HarnessRow[];
  /** Drawn on a tenant's page, where the container is the workspace's. */
  shared: boolean;
  containerAsked: boolean;
  latestAt: string | null;
  lookingUp: boolean;
  updating: HarnessName | null;
  outcome: HarnessUpdateOutcome | null;
  /** The harness being put into the running container right now. */
  applying?: HarnessName | null;
  /** What the last such apply came to. */
  applied?: HarnessApplyOutcome | null;
  trouble: string | null;
  busy: boolean;
  onLookUp: () => void;
  onUpdate: (harness: HarnessName, version: string) => void;
  /** Put the pinned versions of these into the running container. */
  onApply?: (harnesses: HarnessName[]) => void;
  onRebuild: () => void;
}) {
  const stale = awaitingRebuild(rows);
  // The move just made says the same thing in its own sentence, so its harness
  // is not said twice.
  const unsaid = stale.filter(
    (row) => !(outcome?.kind === "moved" && outcome.harness === row.harness),
  );
  const running = install.state === "running";
  return (
    <section className="harness" aria-label="AI harness">
      <h2>AI harness</h2>
      <p className="muted">
        {shared ? (
          <>
            The agent CLI this tenant&apos;s provider spawns. It is installed by the container of{" "}
            <strong>{install.name}</strong>, which every tenant in it shares, so moving it here
            moves it for all of them.
          </>
        ) : (
          <>
            The agent CLIs the container carries, as{" "}
            <span className="mono">container/Dockerfile</span> installs them. A unit runs on the one
            its config&apos;s provider names.
          </>
        )}
      </p>
      {rows.length === 0 ? (
        <p className="muted">
          {shared
            ? "This tenant's config does not say which provider it runs."
            : "The Dockerfile installs none that Phoebe knows."}
        </p>
      ) : (
        <ul className="harness-list">
          {rows.map((row) => (
            <HarnessItem
              key={row.harness}
              row={row}
              shared={shared}
              containerAsked={containerAsked}
              updating={updating}
              busy={busy}
              onUpdate={onUpdate}
            />
          ))}
        </ul>
      )}
      <div className="verbs">
        <Button size="sm" variant="outline" disabled={lookingUp} onClick={onLookUp}>
          {lookingUp ? "Checking…" : "Check for updates"}
        </Button>
        {stale.length === 0 || !running || onApply === undefined ? null : (
          <Button
            size="sm"
            disabled={busy || applying !== null}
            onClick={() => onApply(stale.map((row) => row.harness))}
          >
            {applying === null ? "Apply to the running container" : "Applying…"}
          </Button>
        )}
        {stale.length === 0 && outcome?.kind !== "moved" ? null : (
          <Button size="sm" variant="outline" disabled={busy} onClick={onRebuild}>
            {running ? "Rebuild and restart" : "Rebuild and start"}
          </Button>
        )}
      </div>
      {latestAt === null ? (
        <p className="muted">
          Nothing has been looked up yet. Checking asks npm and Cursor which versions are newest.
        </p>
      ) : (
        <p className="muted">Latest versions as of {new Date(latestAt).toLocaleTimeString()}.</p>
      )}
      {!containerAsked && !running ? (
        <p className="muted">
          The install is stopped, so there is no container to ask what it has.
        </p>
      ) : null}
      {unsaid.map((row) => (
        <p key={row.harness} className="warning">
          The Dockerfile pins {row.label} {row.pin.kind === "pinned" ? row.pin.version : ""} and the
          container has {row.running}. Apply it to the running container, or rebuild.
        </p>
      ))}
      {updating === "cursor" ? (
        <p className="muted">
          Fetching both architectures&apos; tarballs to pin their digests. That is about 165 MB.
        </p>
      ) : null}
      {outcome === null ? null : (
        <p className={outcome.kind === "refused" ? "refusal" : "receipt written"} role="status">
          {updateReading(outcome)}
          {outcome.kind !== "moved" || running ? null : " The next build of the image installs it."}
        </p>
      )}
      {applying === null ? null : (
        <p className="muted">
          Putting it into the running container, beside the one a unit may be using.
        </p>
      )}
      {applied === null || applying !== null ? null : (
        <p className={applied.kind === "applied" ? "receipt written" : "refusal"} role="status">
          {applyReading(applied)}
        </p>
      )}
      {trouble === null ? null : <p className="refusal">{trouble}</p>}
    </section>
  );
}

function HarnessItem({
  row,
  shared,
  containerAsked,
  updating,
  busy,
  onUpdate,
}: {
  row: HarnessRow;
  shared: boolean;
  containerAsked: boolean;
  updating: HarnessName | null;
  busy: boolean;
  onUpdate: (harness: HarnessName, version: string) => void;
}) {
  // What is typed wins; until something is, the field offers the latest known.
  const [typed, setTyped] = useState<string | null>(null);
  const draft = typed ?? row.latest ?? "";
  const standing = harnessStanding(row);
  const pinned = row.pin.kind === "pinned" ? row.pin.version : null;
  const version = draft.trim();

  return (
    <li className="harness-row">
      <div className="harness-what">
        <div className="harness-name">
          <strong>{row.label}</strong>
          <span className="chip">{row.harness}</span>
          {standing === null ? null : (
            <span className={`chip check ${standing.tone}`}>{standing.text}</span>
          )}
        </div>
        <div className="muted">{harnessReading(row, containerAsked)}</div>
        {row.pin.kind === "unpinned" ? (
          <div className="muted">
            Each build installs whatever is newest that day, and nothing records which it got.
          </div>
        ) : null}
        {row.usedBy.length === 0 ? null : row.pin.kind === "absent" ? (
          <div className="refusal">
            {shared
              ? "This tenant runs"
              : `${row.usedBy.join(", ")} ${row.usedBy.length === 1 ? "runs" : "run"}`}{" "}
            on it, and the container has no such CLI: every unit dies as it is spawned.
          </div>
        ) : shared ? null : (
          <div className="muted">Runs {row.usedBy.join(", ")}</div>
        )}
      </div>
      <div className="harness-move">
        <Input
          size="sm"
          className="harness-version mono"
          aria-label={`Version of ${row.label}`}
          placeholder="version"
          value={draft}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || updating !== null || version === "" || version === pinned}
          onClick={() => onUpdate(row.harness, version)}
        >
          {updating === row.harness ? "Moving…" : updateVerb(row.pin)}
        </Button>
      </div>
    </li>
  );
}
