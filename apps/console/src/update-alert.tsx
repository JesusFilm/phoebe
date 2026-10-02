// The update alert: one line over the page that says installs have updates,
// and takes them.
//
// It works the way T3 Code's does, because that is the alert the people using
// this already know. One line, whatever the number of installs behind it: an
// icon, a title, and one action. The title opens the list, each install with
// what would move and a button of its own. Pressing the action turns the line
// into the update itself, with a spinner and the step it is on, and a failure
// turns it into "Could not update" with a Retry. A dismissal is remembered for
// exactly what was on offer, so tomorrow's newer version is a new line.
//
// **Update** takes the harness updates: each pin is moved in the Dockerfile,
// and on a running install the new version is put into the container beside
// the old one, so a unit in flight finishes on what it started with and the
// next one starts on the new. Phoebe's own launcher and engine are listed and
// not moved from here. An upgrade of those runs migrations and can refuse,
// which is a run with output on the install's own page; those installs count
// as needing a manual update, and Review opens the page.

import { ArrowUpCircle, CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  DesktopBridge,
  HarnessReport,
  LocalInstall,
  LocalReportEvent,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  availableUpdates,
  takenReading,
  updateArrow,
  updatesSignature,
  type AvailableUpdate,
  type TakenUpdate,
} from "./harness.ts";
import { refusalText } from "./verb-run.ts";

/** Where one install's update stands. */
export type TargetState =
  | { status: "idle" }
  | { status: "running"; stage: string }
  | { status: "failed"; message: string }
  | { status: "done"; text: string };

/** One install the alert speaks for. */
export type UpdateTarget = {
  install: LocalInstall;
  updates: AvailableUpdate[];
  state: TargetState;
};

/** The one line, as words. */
export type UpdateNotice = {
  status: TargetState["status"];
  title: string;
  /** After the title, muted: the step an update is on, why one failed, what one did. */
  detail: string | null;
  /** The button's label, or null when there is nothing to press. */
  action: string | null;
  /** How many installs the button cannot take, as a clause. */
  manual: string | null;
};

const harnessOnly = (updates: readonly AvailableUpdate[]): AvailableUpdate[] =>
  updates.filter((update) => update.kind === "harness");

/** Whether Update can do anything for this install. */
export function updatable(target: UpdateTarget): boolean {
  return target.state.status !== "running" && harnessOnly(target.updates).length > 0;
}

/**
 * The line for these installs. An update in flight outranks a failure, which
 * outranks an offer: the line says the most urgent thing that is true, and the
 * list behind it has the rest.
 */
export function noticeOf(targets: readonly UpdateTarget[]): UpdateNotice | null {
  if (targets.length === 0) return null;
  const running = targets.filter((target) => target.state.status === "running");
  const failed = targets.filter((target) => target.state.status === "failed");
  const offered = targets.filter((target) => target.state.status === "idle");
  const done = targets.filter((target) => target.state.status === "done");
  const naming = (some: readonly UpdateTarget[]): string =>
    some.length === 1 ? some[0]!.install.name : `${some.length} installs`;

  if (running.length > 0) {
    const state = running[0]!.state;
    return {
      status: "running",
      title: `Updating ${naming(running)}`,
      detail: state.status === "running" ? state.stage : null,
      action: null,
      manual: null,
    };
  }
  if (failed.length > 0) {
    const state = failed[0]!.state;
    return {
      status: "failed",
      title: `Could not update ${naming(failed)}`,
      detail: state.status === "failed" ? state.message : null,
      action: failed.some(updatable) ? "Retry" : null,
      manual: null,
    };
  }
  if (offered.length > 0) {
    const can = offered.filter(updatable);
    const manual = offered.length - can.length;
    return {
      status: "idle",
      title: `Update available for ${naming(offered)}`,
      detail: offered.length === 1 ? offered[0]!.updates.map(updateArrow).join(", ") : null,
      action:
        can.length === 0
          ? null
          : offered.length === 1
            ? "Update"
            : can.length === offered.length
              ? "Update all"
              : `Update ${can.length} ${can.length === 1 ? "install" : "installs"}`,
      manual:
        manual === 0 || can.length === 0
          ? null
          : `${manual} ${manual === 1 ? "needs" : "need"} a manual update`,
    };
  }
  const state = done[0]!.state;
  return {
    status: "done",
    title: `${naming(done)} updated`,
    detail: done.length === 1 && state.status === "done" ? state.text : null,
    action: null,
    manual: null,
  };
}

const DISMISSED_KEY = "phoebe.updates.dismissed";

/** The dismissals that were kept, by install: what was on offer when each was dismissed. */
function readDismissed(): Record<string, string> {
  try {
    const held: unknown = JSON.parse(globalThis.localStorage?.getItem(DISMISSED_KEY) ?? "{}");
    return typeof held === "object" && held !== null ? (held as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function keepDismissed(dismissed: Record<string, string>): void {
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  } catch {
    // Nowhere to keep it; the dismissal lasts as long as the window does.
  }
}

export function UpdateAlerts({
  bridge,
  installs,
  events,
  reports,
  onReview,
}: {
  bridge: DesktopBridge;
  installs: readonly LocalInstall[];
  /** The last read of each install, by folder: who runs what. */
  events: Readonly<Record<string, LocalReportEvent>>;
  /** The last harness report of each install, by folder. */
  reports: Readonly<Record<string, HarnessReport>>;
  /** Open the install's own page, where everything listed here can be moved by hand. */
  onReview: (dir: string) => void;
}) {
  const [dismissed, setDismissed] = useState<Record<string, string>>(readDismissed);
  const [states, setStates] = useState<Record<string, TargetState>>({});
  const [listing, setListing] = useState(false);

  const targets = installs.flatMap((install): UpdateTarget[] => {
    const updates = availableUpdates(
      install,
      events[install.dir] ?? null,
      reports[install.dir] ?? null,
    );
    const state = states[install.dir] ?? { status: "idle" };
    if (state.status !== "idle") return [{ install, updates, state }];
    if (updates.length === 0 || dismissed[install.dir] === updatesSignature(updates)) return [];
    return [{ install, updates, state }];
  });
  const notice = noticeOf(targets);

  // A finished update is said for a moment and then leaves, as a toast does.
  const finished = targets
    .filter((target) => target.state.status === "done")
    .map((target) => target.install.dir)
    .join("\n");
  useEffect(() => {
    if (finished === "") return;
    const timer = setTimeout(() => {
      setStates((held) =>
        Object.fromEntries(Object.entries(held).filter(([, state]) => state.status !== "done")),
      );
    }, 12_000);
    return () => clearTimeout(timer);
  }, [finished]);

  if (notice === null) return null;

  const take = (some: readonly UpdateTarget[]): void => {
    for (const target of some.filter(updatable)) {
      const dir = target.install.dir;
      const set = (state: TargetState): void => setStates((held) => ({ ...held, [dir]: state }));
      set({ status: "running", stage: "starting" });
      void takeUpdates(bridge, target.install, target.updates, (stage) =>
        set({ status: "running", stage }),
      ).then((results) => {
        const text = takenReading(results, target.install.state === "running");
        set(
          results.every((result) => result.why === null)
            ? { status: "done", text }
            : { status: "failed", message: text },
        );
      });
    }
  };

  const dismiss = (): void => {
    const next = { ...dismissed };
    for (const target of targets) {
      if (target.updates.length > 0) next[target.install.dir] = updatesSignature(target.updates);
    }
    setDismissed(next);
    keepDismissed(next);
    setStates((held) =>
      Object.fromEntries(Object.entries(held).filter(([, state]) => state.status === "running")),
    );
    setListing(false);
  };

  return (
    <UpdateNoticeLine
      notice={notice}
      targets={targets}
      listing={listing}
      onList={() => setListing((open) => !open)}
      onTake={take}
      onReview={onReview}
      onDismiss={dismiss}
    />
  );
}

/** The line and the list behind it, with everything they show handed in. */
export function UpdateNoticeLine({
  notice,
  targets,
  listing,
  onList,
  onTake,
  onReview,
  onDismiss,
}: {
  notice: UpdateNotice;
  targets: readonly UpdateTarget[];
  listing: boolean;
  onList: () => void;
  onTake: (targets: readonly UpdateTarget[]) => void;
  onReview: (dir: string) => void;
  onDismiss: () => void;
}) {
  const hover = [notice.title, notice.detail].filter((part) => part !== null).join(": ");
  return (
    <aside className="update-alerts" aria-label="Updates">
      <div
        className={`update-alert ${notice.status}`}
        role={notice.status === "failed" ? "alert" : "status"}
      >
        <span className="update-icon">
          {notice.status === "running" ? (
            <Spinner aria-hidden="true" />
          ) : notice.status === "failed" ? (
            <CircleAlert size={15} aria-hidden="true" />
          ) : notice.status === "done" ? (
            <CircleCheck size={15} aria-hidden="true" />
          ) : (
            <ArrowUpCircle size={15} aria-hidden="true" />
          )}
        </span>
        <button
          type="button"
          className="update-title"
          title={hover}
          aria-label={`${hover}. View installs`}
          aria-expanded={listing}
          onClick={onList}
        >
          {notice.title}
          {notice.detail === null ? null : (
            <>
              <span className="update-separator" aria-hidden="true">
                ·
              </span>
              <span className="update-detail">{notice.detail}</span>
            </>
          )}
        </button>
        <span className="update-actions">
          {notice.manual === null ? null : <span className="muted">{notice.manual}</span>}
          {notice.action === null ? null : (
            <Button size="xs" variant="ghost" onClick={() => onTake(targets)}>
              {notice.action}
            </Button>
          )}
          {notice.status === "running" ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Dismiss"
              aria-label="Dismiss the update alert"
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </span>
      </div>
      {listing ? (
        <ul className="update-list" aria-label="Installs with updates">
          {targets.map((target) => (
            <li key={target.install.dir}>
              <div className="update-target">
                <strong>{target.install.name}</strong>
                <span className="muted">{targetReading(target)}</span>
              </div>
              <span className="update-actions">
                {updatable(target) ? (
                  <Button size="xs" variant="outline" onClick={() => onTake([target])}>
                    {target.state.status === "failed" ? "Retry" : "Update"}
                  </Button>
                ) : null}
                <Button size="xs" variant="ghost" onClick={() => onReview(target.install.dir)}>
                  Review
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

/** One install's row in the list: what would move, or how its update is going. */
export function targetReading(target: UpdateTarget): string {
  switch (target.state.status) {
    case "running":
      return target.state.stage;
    case "failed":
      return target.state.message;
    case "done":
      return target.state.text;
    case "idle": {
      const moves = target.updates.map(updateArrow).join(", ");
      return target.updates.some((update) => update.kind !== "harness")
        ? `${moves}. Phoebe's own upgrade runs migrations, so it is started from the install's page.`
        : moves;
    }
  }
}

/**
 * Take every harness update on one install, one after another: move the pin,
 * then put it into the container if there is one running, saying each step as
 * it starts. A refusal on one is recorded and the rest still go, since each
 * harness is its own line in the file. Ends on a fresh check, so every page
 * and the alert itself see what the install is on now.
 */
export async function takeUpdates(
  bridge: DesktopBridge,
  install: LocalInstall,
  updates: readonly AvailableUpdate[],
  onStage: (stage: string) => void = () => undefined,
): Promise<TakenUpdate[]> {
  const results: TakenUpdate[] = [];
  for (const update of updates) {
    if (update.kind !== "harness") continue;
    const result: TakenUpdate = { label: update.label, to: update.to, why: null, applied: false };
    try {
      onStage(`pinning ${update.label} ${update.to}`);
      const moved = await bridge.harness.update(install.dir, {
        harness: update.harness,
        version: update.to,
      });
      if (moved.kind === "refused") result.why = moved.why;
      else if (install.state === "running") {
        onStage(`putting ${update.label} ${update.to} into the running container`);
        const applied = await bridge.harness.apply(install.dir, update.harness);
        if (applied.kind === "applied") result.applied = true;
        else result.why = `pinned, but not put into the running container: ${applied.why}`;
      }
    } catch (error) {
      result.why = refusalText(error);
    }
    results.push(result);
  }
  await bridge.harness.check(install.dir, { lookUp: false }).catch(() => undefined);
  return results;
}
