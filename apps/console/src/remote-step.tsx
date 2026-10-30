// The **Remote** step on a local install's install tab, and the Devices panel
// a local install with a `remote` block carries (map #690; #695, #696, #699).
//
// No `remote` block: say what to add to `phoebe.config.ts`, and that it is a
// boot-time, local file edit. With one: name the arm and the address, and once
// the install runs offer the two mints. **Pair this companion** runs `phoebe
// pair --operate`, takes the code off the run's outcome and spends it itself
// through `remotes.pair`; the person never sees it, and the host's section
// appears on the rail. **Link for another device** runs `phoebe pair` and
// shows the link, the code in large type, copy buttons, a QR of the link, the
// scope and until when. The run's lines say "code minted" and never carry it
// (verb-run.ts): what is drawn here is the outcome, and only when asked for.

import { useEffect, useRef, useState } from "react";
import type {
  DesktopBridge,
  LocalInstall,
  LocalReportEvent,
  PairOutcome,
  PairResult,
  RemoteRecord,
  SessionRow,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { DevicesPanel } from "./devices-panel.tsx";
import { encodeQr, qrSvg } from "./qr.ts";
import { readReport } from "./report.ts";
import { addFailureLine, remoteSectionOf } from "./remote-routes.ts";
import { renderableReport } from "./local-install.ts";
import { hostnameOf } from "./reachability.ts";
import { revokeLine } from "./remote-page.tsx";

/** What the report says about the install's `remote` block, or null with no readable report. */
export function remoteBlockOf(
  install: LocalInstall,
  event: LocalReportEvent | null,
): { configured: boolean; arm: string | null; url: string | null } | null {
  const section = remoteSectionOf(readReport(renderableReport(install, event)));
  if (section === null) return null;
  return { configured: section.configured, arm: section.arm, url: section.url };
}

/** The run's outcome, when it was a pair. */
export function pairOutcomeOf(run: VerbRun | null): PairOutcome | null {
  const outcome = run?.exit?.outcome;
  return outcome?.verb === "pair" ? outcome.outcome : null;
}

/** The origin a pairing link names, which is what a pair is sent to. */
export function originOfLink(link: string): string {
  try {
    const url = new URL(link);
    return `${url.protocol}//${url.host}`;
  } catch {
    return link.split("/pair")[0] ?? link;
  }
}

/** `HH:MM`, local time, for "spendable until". */
export function hhmm(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "??:??";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function RemoteStep({
  install,
  bridge,
  report,
  run,
  running,
  onStart,
  joined,
  defaultLabel,
  onOpenRemote,
  onPaired,
}: {
  install: LocalInstall;
  bridge: DesktopBridge;
  report: LocalReportEvent | null;
  run: VerbRun | null;
  running: boolean;
  onStart: (request: VerbRunRequest) => void;
  /** The paired record with this install's deployment id, when there is one. */
  joined: RemoteRecord | null;
  defaultLabel: string;
  onOpenRemote: (record: RemoteRecord) => void;
  onPaired: (record: RemoteRecord) => void;
}) {
  const block = remoteBlockOf(install, report);
  // Which mint the last press was: the one this companion spends, or the one
  // shown for another device. Held here, since the run itself cannot say.
  const [intent, setIntent] = useState<"self" | "link" | null>(null);
  const [selfResult, setSelfResult] = useState<PairResult | null>(null);
  const spent = useRef<string | null>(null);
  const outcome = pairOutcomeOf(run);

  // The companion spends the code the moment the run that minted it ends.
  useEffect(() => {
    if (intent !== "self" || outcome === null || run === null) return;
    if (spent.current === run.runId) return;
    spent.current = run.runId;
    bridge.remotes
      .pair({ url: originOfLink(outcome.url), code: outcome.code, label: defaultLabel })
      .then(
        (result) => {
          setSelfResult(result);
          if (result.outcome === "paired") onPaired(result.record);
        },
        (error: unknown) =>
          setSelfResult({
            outcome: "unreachable",
            detail: error instanceof Error ? error.message : String(error),
          }),
      );
  }, [bridge, intent, outcome, run, defaultLabel, onPaired]);

  const mint = (operate: boolean): void => {
    setIntent(operate ? "self" : "link");
    setSelfResult(null);
    onStart({ install: install.dir, verb: "pair", ...(operate ? { operate: true } : {}) });
  };

  const pairRun = run !== null && run.verb === "pair";
  const refused = pairRun && run.exit !== undefined && run.exit.code !== 0;

  return (
    <section className="remote-step" aria-label="Remote">
      <h2>Remote</h2>
      {block === null || !block.configured ? (
        <>
          <p className="muted step-detail">
            {install.state === "running" && block !== null
              ? "Not configured. "
              : install.state === "running"
                ? "Reading the report… "
                : "Needs a running install to say. "}
            Add <code>remote: {'{ tailscale: "host" }'}</code> (or <code>&quot;sidecar&quot;</code>)
            to <code>phoebe.config.ts</code>, then stop and start. A boot-time field, and a local
            file edit: the companion does not write it.
          </p>
        </>
      ) : (
        <>
          <p className="step-detail">
            <strong>{block.arm}</strong> arm ·{" "}
            {block.url === null ? (
              <span className="muted">no tailnet address yet</span>
            ) : (
              <span className="mono">{hostnameOf(block.url)}</span>
            )}
            {joined === null ? null : (
              <>
                {" "}
                <span className="chip ok">this companion is paired</span>{" "}
                <button
                  type="button"
                  className="chip route-chip"
                  title="the same deployment over the API"
                  onClick={() => onOpenRemote(joined)}
                >
                  ↗ open over Tailscale
                </button>
              </>
            )}
          </p>
          {install.state === "running" ? (
            <div className="verbs">
              {joined === null ? (
                <button type="button" disabled={running} onClick={() => mint(true)}>
                  Pair this companion
                </button>
              ) : null}
              <button type="button" disabled={running} onClick={() => mint(false)}>
                Link for another device
              </button>
            </div>
          ) : (
            <p className="muted">Start the install to pair with it.</p>
          )}
          <p className="muted small">
            Pair this companion mints with <code>--operate</code> and spends the code itself; Link
            for another device mints <code>read</code> and shows the link once. Each runs the same
            verb the CLI runs, in the companion&apos;s main process.
          </p>
        </>
      )}
      {refused ? (
        <p className="refusal">
          <code>phoebe pair</code> was refused — exited {run.exit!.code}. The console&apos;s cli tab
          has what it said.
        </p>
      ) : null}
      {intent === "self" && selfResult !== null ? (
        selfResult.outcome === "paired" ? (
          <p className="outcome">
            Paired. {hostnameOf(selfResult.record.url)} is on the rail now.{" "}
            <button
              type="button"
              className="chip route-chip"
              onClick={() => onOpenRemote(selfResult.record)}
            >
              ↗ open over Tailscale
            </button>
          </p>
        ) : (
          <p className="refusal">{addFailureLine(selfResult, null)}</p>
        )
      ) : null}
      {intent === "link" && outcome !== null && !refused ? <MintCard outcome={outcome} /> : null}
    </section>
  );
}

/** The minted link, the code in large type, copy buttons, a QR, the scope and until when. */
export function MintCard({ outcome }: { outcome: PairOutcome }) {
  const matrix = encodeQr(outcome.url);
  const expired = Date.parse(outcome.expiresAt) <= Date.now();
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <div className="mint-card" aria-label="Link for another device">
      <div className="mint-text">
        <h3>Link for another device</h3>
        <div className="linkbox mono">{outcome.url}</div>
        <p className="verbs">
          <button type="button" className="quiet" onClick={() => copy(outcome.url)}>
            copy link
          </button>
          <span className="muted small">paste it into a companion&apos;s add remote</span>
        </p>
        <div className="mint-code mono" aria-label="Pairing code">
          {outcome.code}
        </div>
        <p className="verbs">
          <button type="button" className="quiet" onClick={() => copy(outcome.code)}>
            copy code
          </button>
          <span className="muted small">
            or type the code against <code>{hostnameOf(originOfLink(outcome.url))}</code>
          </span>
        </p>
        <p className="muted small">
          scope{" "}
          {outcome.scopes.map((scope) => (
            <span key={scope} className="chip">
              {scope}
            </span>
          ))}{" "}
          · single use · spendable until {hhmm(outcome.expiresAt)} (5 min)
          {expired ? <span className="bad"> · expired, mint again</span> : null}
        </p>
        <p className="muted small">
          The code is shown here once; the streamed lines never carry it. The device that spends it
          chooses its own label.
        </p>
      </div>
      {matrix === null ? null : (
        <div className="mint-qr">
          <div
            role="img"
            aria-label="QR code of the pairing link"
            // The SVG is this module's own output over the link, with nothing
            // from anywhere else in it.
            dangerouslySetInnerHTML={{ __html: qrSvg(matrix) }}
          />
          <p className="muted small">scan from a phone</p>
        </div>
      )}
    </div>
  );
}

/** The Devices panel on a local install: read through a `sessions` run over compose exec. */
export function LocalDevices({
  install,
  report,
  run,
  running,
  now,
  onStart,
}: {
  install: LocalInstall;
  report: LocalReportEvent | null;
  run: VerbRun | null;
  running: boolean;
  now: Date;
  onStart: (request: VerbRunRequest) => void;
}) {
  const section = remoteSectionOf(readReport(renderableReport(install, report)));
  const outcome = run?.exit?.outcome;
  const rows: SessionRow[] | null = outcome?.verb === "sessions" ? outcome.outcome.sessions : null;
  const [trouble, setTrouble] = useState<string | null>(null);
  if (section === null || !section.configured) return null;
  return (
    <DevicesPanel
      rows={rows}
      self={null}
      canOperate={!running}
      tampered={section.tampered}
      counts={section.sessions}
      now={now}
      note="Read over compose exec. Also on the host: phoebe sessions, and phoebe sessions revoke <id|--all>."
      trouble={trouble}
      onRead={() => {
        setTrouble(null);
        onStart({ install: install.dir, verb: "sessions" });
      }}
      onRevoke={(sessionId) => {
        setTrouble(revokeLine({ outcome: "revoked" }));
        onStart({ install: install.dir, verb: "sessions", revoke: { id: sessionId } });
      }}
    />
  );
}
