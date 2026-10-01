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
  HarnessName,
  HarnessReport,
  HarnessUpdateOutcome,
  LocalInstall,
  LocalReportEvent,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  awaitingRebuild,
  harnessReading,
  harnessRows,
  harnessStanding,
  harnessUsers,
  updateReading,
  updateVerb,
  type HarnessRow,
} from "./harness.ts";
import { refusalText } from "./verb-run.ts";

export function HarnessSection({
  install,
  bridge,
  event,
  tenant,
  busy,
  onRebuild,
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
}) {
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [updating, setUpdating] = useState<HarnessName | null>(null);
  const [outcome, setOutcome] = useState<HarnessUpdateOutcome | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

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
  const pins = JSON.stringify(event?.directory.harnessPins ?? null);
  useEffect(() => {
    void check(false);
  }, [check, pins, install.state]);

  const update = (harness: HarnessName, version: string): void => {
    setUpdating(harness);
    setOutcome(null);
    bridge.harness
      .update(install.dir, { harness, version })
      .then(setOutcome, (error: unknown) =>
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
    <HarnessPanel
      install={install}
      rows={rows}
      shared={tenant !== undefined}
      containerAsked={report?.containerAsked ?? false}
      latestAt={report?.latestAt ?? null}
      lookingUp={lookingUp}
      updating={updating}
      outcome={outcome}
      trouble={trouble}
      busy={busy}
      onLookUp={() => void check(true)}
      onUpdate={update}
      onRebuild={onRebuild}
    />
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
  trouble,
  busy,
  onLookUp,
  onUpdate,
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
  trouble: string | null;
  busy: boolean;
  onLookUp: () => void;
  onUpdate: (harness: HarnessName, version: string) => void;
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
        {stale.length === 0 && outcome?.kind !== "moved" ? null : (
          <Button size="sm" disabled={busy} onClick={onRebuild}>
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
          container has {row.running}. Rebuild to pick the pin up.
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
