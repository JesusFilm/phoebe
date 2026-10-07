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

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  ClaudeSignInOutcome,
  DesktopBridge,
  HarnessApplyOutcome,
  HarnessName,
  HarnessRemoveOutcome,
  HarnessReport,
  HarnessUpdateOutcome,
  LocalInstall,
  LocalReportEvent,
  RepairOutcome,
  ToolAddOutcome,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  applyReading,
  awaitingRebuild,
  CLAUDE_TOKEN_KEY,
  claudeAuthReading,
  engineReading,
  engineStanding,
  harnessReading,
  harnessRows,
  harnessStanding,
  harnessSettings,
  harnessUsers,
  HARNESS_LABEL,
  launcherStanding,
  launcherVersionOf,
  needsRebuild,
  phoebeVersions,
  providerOf,
  removeReading,
  rootReading,
  toolAddReading,
  toolsReading,
  updateReading,
  volumesReading,
  updateVerb,
  upgradeReading,
  type ClaudeAuthReading,
  type HarnessRow,
  type PhoebeVersions,
} from "./harness.ts";
import { ConfigFieldRow, saveRequest } from "./config-form.tsx";
import { receiptReading, secretSetRequest } from "./local-install.ts";
import { receiptOfRun, refusalText } from "./verb-run.ts";

export function HarnessSection({
  install,
  bridge,
  event,
  tenant,
  busy,
  onRebuild,
  run = null,
  onStart,
  onTenant,
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
   * Start a run on the install: `upgrade` for Phoebe's own versions on the
   * install's page, `config set` for what a config runs on either page.
   */
  onStart?: (request: VerbRunRequest) => void;
  /** Open a tenant's own page, where its provider, model and effort are set. */
  onTenant?: (dir: string) => void;
}) {
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [updating, setUpdating] = useState<HarnessName | null>(null);
  const [outcome, setOutcome] = useState<HarnessUpdateOutcome | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [owning, setOwning] = useState(false);
  const [owned, setOwned] = useState<RepairOutcome | null>(null);
  const [applying, setApplying] = useState<HarnessName | null>(null);
  const [applied, setApplied] = useState<HarnessApplyOutcome | null>(null);
  const [removing, setRemoving] = useState<HarnessName | null>(null);
  const [addingTool, setAddingTool] = useState<string | null>(null);
  const [toolAdded, setToolAdded] = useState<ToolAddOutcome | null>(null);
  const [removed, setRemoved] = useState<HarnessRemoveOutcome | null>(null);

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
  const update = (harness: HarnessName, typed: string): void => {
    setUpdating(harness);
    setOutcome(null);
    setApplied(null);
    setRemoved(null);
    // Nothing typed means the newest: looked up now if it has not been.
    const version =
      typed !== ""
        ? Promise.resolve(typed)
        : bridge.harness.check(install.dir, { lookUp: true }).then((found) => {
            setReport(found);
            return found.harnesses.find((row) => row.harness === harness)?.latest ?? null;
          });
    version
      .then((wanted) =>
        wanted === null
          ? Promise.resolve<HarnessUpdateOutcome>({
              kind: "refused",
              harness,
              why: "the newest version could not be looked up",
              instruction: null,
            })
          : bridge.harness.update(install.dir, { harness, version: wanted }),
      )
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

  const remove = (harness: HarnessName): void => {
    setRemoving(harness);
    setOutcome(null);
    setApplied(null);
    setRemoved(null);
    bridge.harness
      .remove(install.dir, harness)
      .then(setRemoved, (error: unknown) =>
        setRemoved({ kind: "refused", harness, why: refusalText(error) }),
      )
      .finally(() => setRemoving(null));
  };

  const users = harnessUsers(install, event);
  const only =
    tenant === undefined ? null : (users.find((user) => user.dir === tenant)?.harness ?? null);
  // The install's own page lists every harness there is, installed or not, so
  // one can be added; a tenant's page lists the one it runs.
  const rows = harnessRows(report, event, users, only, tenant === undefined);
  // No Dockerfile, no section: a tenant's folder added on its own, or a folder
  // not initialised yet, has no container of its own to speak of.
  if (
    event?.directory.harnessPins === undefined &&
    (report === null || report.dockerfile === null)
  ) {
    return null;
  }

  const root = rootReading(install, event, report);
  const volumes = volumesReading(report);
  const auth = claudeAuthReading(report);
  const tools = toolsReading(install, event, report);
  const addTool = (tool: string): void => {
    setAddingTool(tool);
    setToolAdded(null);
    bridge.harness
      .addTool(install.dir, tool)
      .then(setToolAdded, (error: unknown) =>
        setToolAdded({ kind: "refused", tool, why: refusalText(error) }),
      )
      .finally(() => {
        setAddingTool(null);
        void check(false);
      });
  };
  const own = (): void => {
    setOwning(true);
    setOwned(null);
    bridge.installs
      .repair(install.dir, { kind: "volume-ownership" })
      .then(setOwned, (error: unknown) => setOwned({ fixed: false, detail: refusalText(error) }))
      .finally(() => {
        setOwning(false);
        void check(false);
      });
  };
  return (
    <>
      {volumes === null && owned === null ? null : (
        <section className="fixable" aria-label="The container cannot write its volumes">
          {/* Once they are handed over the heading says so, not what was wrong. */}
          <h2>
            {volumes === null
              ? "The volumes were handed over"
              : "The container cannot write its volumes"}
          </h2>
          {volumes === null ? null : (
            <>
              <p>{volumes}</p>
              <Button size="sm" disabled={busy || owning} onClick={own}>
                {owning ? "Handing them over…" : "Give them to the container's user"}
              </Button>
            </>
          )}
          {owned === null ? null : (
            <p className={owned.fixed ? "receipt written" : "refusal"} role="status">
              {owned.detail}
              {owned.fixed && install.state !== "running" ? " Start the install." : null}
            </p>
          )}
          {owned?.fixed === true && install.state !== "running" && onStart !== undefined ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onStart({ install: install.dir, verb: "start" })}
            >
              Start
            </Button>
          ) : null}
        </section>
      )}
      {root === null ? null : (
        <section className="fixable" aria-label="The container runs as root">
          <h2>The container runs as root</h2>
          <p>{root.text}</p>
          {root.rebuild ? (
            <Button size="sm" disabled={busy} onClick={onRebuild}>
              {install.state === "running" ? "Rebuild and restart" : "Rebuild and start"}
            </Button>
          ) : null}
        </section>
      )}
      {auth.length === 0 ? null : (
        <ClaudeSignIn
          install={install}
          event={event}
          readings={auth}
          bridge={bridge}
          busy={busy}
          onStart={onStart}
        />
      )}
      {tools.length === 0 && toolAdded === null ? null : (
        <section className="fixable" aria-label="Tooling the commands need">
          <h2>Tooling the commands need</h2>
          {tools.map((reading) => (
            <div key={reading.tool} className="tool-need">
              <p>{reading.text}</p>
              {reading.remedy === "add" ? (
                <Button
                  size="sm"
                  disabled={busy || addingTool !== null}
                  onClick={() => addTool(reading.tool)}
                >
                  {addingTool === reading.tool
                    ? "Adding…"
                    : `Add ${reading.tool} to the Dockerfile`}
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={onRebuild}>
                  {install.state === "running" ? "Rebuild and restart" : "Rebuild and start"}
                </Button>
              )}
            </div>
          ))}
          {toolAdded === null ? null : (
            <p className={toolAdded.kind === "added" ? "receipt written" : "refusal"} role="status">
              {toolAddReading(toolAdded)}
            </p>
          )}
          {toolAdded?.kind === "added" && tools.every((reading) => reading.remedy !== "rebuild") ? (
            <Button size="sm" disabled={busy} onClick={onRebuild}>
              {install.state === "running" ? "Rebuild and restart" : "Rebuild and start"}
            </Button>
          ) : null}
        </section>
      )}
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
        removing={removing}
        removed={removed}
        trouble={trouble}
        busy={busy}
        onLookUp={() => void check(true)}
        onUpdate={update}
        onRemove={remove}
        onApply={(harnesses) => void apply(harnesses)}
        onRebuild={onRebuild}
        settings={
          // A tenant's page has its whole config form above this section, with
          // these three as its first rows, so they are not drawn a second time.
          tenant !== undefined ? (
            <p className="muted">
              Which provider this tenant spawns, and the model and effort, are the first rows of its
              config above.
            </p>
          ) : onStart === undefined ? null : (
            <HarnessSettings
              install={install}
              event={event}
              run={run}
              busy={busy}
              onStart={onStart}
              {...(onTenant === undefined ? {} : { onTenant })}
            />
          )
        }
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
  removing = null,
  removed = null,
  trouble,
  busy,
  onLookUp,
  onUpdate,
  onRemove,
  onApply,
  onRebuild,
  settings = null,
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
  /** The harness being taken out of the Dockerfile right now, and what the last removal came to. */
  removing?: HarnessName | null;
  removed?: HarnessRemoveOutcome | null;
  trouble: string | null;
  busy: boolean;
  onLookUp: () => void;
  /** Move a pin, or add the harness. An empty version means the newest. */
  onUpdate: (harness: HarnessName, version: string) => void;
  /** Take a harness out of the Dockerfile. Absent, rows cannot be removed. */
  onRemove?: (harness: HarnessName) => void;
  /** Put the pinned versions of these into the running container. */
  onApply?: (harnesses: HarnessName[]) => void;
  onRebuild: () => void;
  /** What runs on the harnesses (HarnessSettings), drawn under the list. */
  settings?: ReactNode;
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
              removing={removing}
              busy={busy}
              onUpdate={onUpdate}
              {...(onRemove === undefined ? {} : { onRemove })}
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
        {stale.length === 0 && outcome?.kind !== "moved" && removed?.kind !== "removed" ? null : (
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
      {removed === null ? null : (
        <p className={removed.kind === "removed" ? "receipt written" : "refusal"} role="status">
          {removeReading(removed)}
        </p>
      )}
      {settings}
      {trouble === null ? null : <p className="refusal">{trouble}</p>}
    </section>
  );
}

function HarnessItem({
  row,
  shared,
  containerAsked,
  updating,
  removing = null,
  busy,
  onUpdate,
  onRemove,
}: {
  row: HarnessRow;
  shared: boolean;
  containerAsked: boolean;
  updating: HarnessName | null;
  removing?: HarnessName | null;
  busy: boolean;
  onUpdate: (harness: HarnessName, version: string) => void;
  onRemove?: (harness: HarnessName) => void;
}) {
  // What is typed wins; until something is, the field offers the latest known.
  const [typed, setTyped] = useState<string | null>(null);
  // Remove asks first: a harness gone from the file is gone from the next image.
  const [confirming, setConfirming] = useState(false);
  const draft = typed ?? row.latest ?? "";
  const standing = harnessStanding(row);
  const pinned = row.pin.kind === "pinned" ? row.pin.version : null;
  const version = draft.trim();
  const settled = busy || updating !== null || removing !== null;
  const verb = updateVerb(row.pin);

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
          placeholder="latest"
          value={draft}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={settled || (version !== "" && version === pinned)}
          title={version === "" ? `${verb} the newest version` : `${verb} ${version}`}
          onClick={() => onUpdate(row.harness, version)}
        >
          {updating === row.harness ? "Moving…" : version === "" ? `${verb} latest` : verb}
        </Button>
        {onRemove === undefined || row.pin.kind === "absent" ? null : confirming ? (
          <span className="harness-confirm" role="alert">
            {row.usedBy.length === 0
              ? "Take it out of the Dockerfile?"
              : `${row.usedBy.join(", ")} ${row.usedBy.length === 1 ? "runs" : "run"} on it. Take it out anyway?`}{" "}
            <Button
              size="sm"
              variant="destructive"
              disabled={settled}
              onClick={() => {
                setConfirming(false);
                onRemove(row.harness);
              }}
            >
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={settled}
            title={`Take ${row.label} out of the Dockerfile`}
            onClick={() => setConfirming(true)}
          >
            {removing === row.harness ? "Removing…" : "Remove"}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * What runs on the harnesses: the provider a config names, and the model and
 * effort it runs that provider at. The same three rows the config form draws
 * (config-form.tsx), saved the same way, here because this is where somebody
 * choosing a harness is looking and the config form is a tab away. A solo
 * install's sets its one config's; a workspace's lists its tenants and sends
 * each to its page, where the config form has the rows.
 */
export function HarnessSettings({
  install,
  event,
  run,
  tenant,
  busy,
  onStart,
  onTenant,
}: {
  install: LocalInstall;
  event: LocalReportEvent | null;
  run: VerbRun | null;
  tenant?: string;
  busy: boolean;
  onStart: (request: VerbRunRequest) => void;
  onTenant?: (dir: string) => void;
}) {
  if (event === null) return null;
  const workspace = install.workspace !== undefined;

  if (workspace && tenant === undefined) {
    const tenants = event.directory.tenants ?? [];
    if (tenants.length === 0) return null;
    return (
      <div className="harness-settings">
        <h3>What runs on them</h3>
        <p className="muted">
          Each tenant names its provider, and the model and effort it runs it at, in its own config.
        </p>
        <ul className="harness-users">
          {tenants.map((one) => {
            const provider = providerOf(one.configFields);
            return (
              <li key={one.dir}>
                <span>
                  <strong>{one.slug ?? one.name}</strong>
                  <span className="muted">
                    {" "}
                    {provider === null ? "no provider read" : `runs ${HARNESS_LABEL[provider]}`}
                  </span>
                </span>
                {onTenant === undefined ? null : (
                  <Button size="sm" variant="ghost" onClick={() => onTenant(one.dir)}>
                    Configure
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // The one config: the tenant's, or the solo install's own.
  const own =
    tenant === undefined
      ? {
          fields: event.directory.configFields,
          fingerprint: event.directory.configFingerprint,
          path: event.directory.configPath,
        }
      : (() => {
          const found = event.directory.tenants?.find((one) => one.dir === tenant);
          return found === undefined
            ? null
            : {
                fields: found.configFields,
                fingerprint: found.configFingerprint,
                path: found.configPath,
              };
        })();
  if (own === null || own.fingerprint === null) return null;
  const fields = harnessSettings(own.fields);
  if (fields.length === 0) return null;
  const { fingerprint, path } = own;
  const receipt = receiptOfRun(run, path);

  return (
    <div className="harness-settings">
      <h3>What runs on it</h3>
      <p className="muted">
        Which provider {tenant === undefined ? "this install" : "this tenant"} spawns, and the model
        and effort it asks for. Saved into its config as the config form saves them.
      </p>
      {fields.map((field) => (
        <ConfigFieldRow
          key={field.path}
          field={field}
          running={busy}
          onSave={(value) =>
            onStart(
              saveRequest({
                install: install.dir,
                field,
                value,
                fingerprint,
                ...(tenant === undefined ? {} : { tenant }),
              }),
            )
          }
        />
      ))}
      {receipt === null ? null : (
        <p className={receipt.state === "written" ? "receipt written" : "refusal"} role="status">
          {receiptReading(receipt)}
        </p>
      )}
    </div>
  );
}

/**
 * Claude Code refusing to run for want of a sign-in, and the way back in.
 *
 * The sign-in is Claude Code's own: `claude setup-token` in a terminal on this
 * machine, a browser, and a long-lived token printed at the end. The companion
 * opens that terminal and takes the token back, into the tenant's secrets as
 * `CLAUDE_CODE_OAUTH_TOKEN` through the same `secret set` every other secret
 * uses: the container's store on a running install, the install's `.env` on a
 * stopped one. A token already to hand can be pasted without the terminal.
 */
export function ClaudeSignIn({
  install,
  event,
  readings,
  bridge,
  busy,
  onStart,
}: {
  install: LocalInstall;
  event: LocalReportEvent | null;
  readings: ClaudeAuthReading[];
  bridge: DesktopBridge;
  busy: boolean;
  onStart?: (request: VerbRunRequest) => void;
}) {
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState<ClaudeSignInOutcome | null>(null);
  const [token, setToken] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const signIn = readings.some((reading) => reading.signIn);
  // A workspace sets the token for the tenant that needs it; a solo install for itself.
  const tenants = readings
    .map((reading) =>
      install.workspace === undefined
        ? null
        : (event?.directory.tenants?.find((tenant) => tenant.slug === reading.slug)?.dir ?? null),
    )
    .filter((dir): dir is string => dir !== null);
  const open = (): void => {
    setOpening(true);
    bridge.harness
      .signInClaude()
      .then(setOpened, (error: unknown) => setOpened({ opened: false, detail: refusalText(error) }))
      .finally(() => setOpening(false));
  };
  const save = (): void => {
    if (onStart === undefined) return;
    setRefused(null);
    const targets = install.workspace === undefined ? [undefined] : tenants;
    try {
      for (const tenant of targets) {
        onStart(
          secretSetRequest({
            install,
            key: CLAUDE_TOKEN_KEY,
            value: token.trim(),
            ...(tenant === undefined ? {} : { tenant }),
          }),
        );
      }
      // Emptied now: a box still holding a token is a box read over a shoulder.
      setToken("");
    } catch (error) {
      setRefused(refusalText(error));
    }
  };

  return (
    <section className="fixable" aria-label="Claude Code is not signed in">
      <h2>{signIn ? "Claude Code is not signed in" : "Claude Code's subscription has lapsed"}</h2>
      {readings.map((reading) => (
        <p key={reading.slug}>
          {reading.text} <span className="muted mono">{reading.said}</span>
        </p>
      ))}
      {!signIn || onStart === undefined ? null : (
        <>
          <div className="verbs">
            <Button size="sm" disabled={opening} onClick={open}>
              {opening ? "Opening…" : "Sign in to Claude"}
            </Button>
          </div>
          {opened === null ? (
            <p className="muted">
              Opens a terminal with <span className="mono">claude setup-token</span>, Claude
              Code&apos;s own sign-in: finish it in the browser it opens, then paste the token it
              prints here. The token goes into this install&apos;s secrets as{" "}
              <span className="mono">{CLAUDE_TOKEN_KEY}</span>.
            </p>
          ) : (
            <p className={opened.opened ? "muted" : "refusal"}>{opened.detail}</p>
          )}
          <div className="verbs">
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              className="mono harness-token"
              aria-label="Claude sign-in token"
              placeholder="sk-ant-oat01-…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                token.trim() === "" ||
                (install.workspace !== undefined && tenants.length === 0)
              }
              onClick={save}
            >
              Set the token
            </Button>
          </div>
          {token.trim() !== "" && !token.trim().startsWith("sk-ant-oat") ? (
            <p className="muted">
              A subscription token starts with <span className="mono">sk-ant-oat</span>. This will
              be set as given.
            </p>
          ) : null}
          {refused === null ? null : <p className="refusal">{refused}</p>}
        </>
      )}
    </section>
  );
}
