// A remote route's page: the same five tabs a local install has, fed by the
// record's last report, with the connection card saying how the facts got
// here and the Devices panel under it (map #690; #696, #697, #699).
//
// No install tab: there is no folder here to init or start. What there is
// instead is the session — its scopes and expiry, sign out — and the three
// writes the API takes, each through the remote client with the bearer added
// in main. A `read` session sees every control disabled with "needs operate";
// a refused receipt renders as it does locally.
//
// Dark, blocked and reconnecting put one line above the tabs and grey the last
// report under it: the page keeps what it last knew rather than hiding it.

import { useEffect, useState, type FormEvent } from "react";
import type {
  DesktopBridge,
  DoctorRunResponse,
  EditReceipt,
  LocalInstall,
  RemoteRecord,
  RevokeOutcome,
  SessionRow,
} from "phoebe-agent/contracts";
import { DeploymentTabPanel, ReceiptPanel } from "./deployment-tabs.tsx";
import { DevicesPanel } from "./devices-panel.tsx";
import { readLiteral } from "./local-install.ts";
import { createRemoteClient, requestTrouble, type RemoteSecretReceipt } from "./remote-client.ts";
import {
  canOperate,
  NEEDS_OPERATE,
  pageBanner,
  remoteConnection,
  remoteRow,
  remoteSectionOf,
} from "./remote-routes.ts";
import { DEPLOYMENT_TABS, type ConfigReading, type DeploymentTab } from "./tabs.ts";

export function RemotePage({
  record,
  bridge,
  tab,
  now,
  joined,
  onTab,
  onPairAgain,
  onSignOut,
  onForget,
  onOpenLocal,
}: {
  record: RemoteRecord;
  bridge: DesktopBridge;
  tab: DeploymentTab;
  now: Date;
  /** The folder on this machine with the same deployment id, when there is one. */
  joined: LocalInstall | null;
  onTab: (tab: DeploymentTab) => void;
  onPairAgain: (record: RemoteRecord) => void;
  onSignOut: (record: RemoteRecord) => void;
  onForget: (record: RemoteRecord) => void;
  /** Open the local route of a joined deployment. */
  onOpenLocal: (install: LocalInstall) => void;
}) {
  const row = remoteRow(record, now);
  const operate = canOperate(record);
  const client = createRemoteClient(bridge, record.deploymentId);
  const banner = pageBanner(row, now);
  const section = remoteSectionOf(row.reading);
  const connection = {
    ...remoteConnection(record, now),
    ...(joined === null
      ? {}
      : {
          link: {
            href: "#",
            text: "↗ this machine",
            title: "the folder on this machine, read over compose exec",
          },
        }),
  };
  const config: ConfigReading | null =
    row.reading.kind === "read" && row.reading.report.config !== undefined
      ? {
          kind: "file",
          path: row.reading.report.config.root.path,
          text: "(the file lives on the deployment; its effective settings are in the report)",
          fingerprint: row.reading.report.config.root.fingerprint ?? "",
        }
      : null;

  return (
    <main className="main remote-page">
      <div className="page-body">
        <div className="install-title">
          <h1>{record.name}</h1>
          {joined === null ? null : (
            <button
              type="button"
              className="chip route-chip"
              title="the folder on this machine, read over compose exec"
              onClick={() => onOpenLocal(joined)}
            >
              ↗ this machine
            </button>
          )}
        </div>
        {banner === null ? null : (
          <p className={`notice ${row.tone}`} role="status">
            {banner}
            {row.blocked === null ? null : (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() =>
                    row.blocked?.action === "update"
                      ? void bridge.updates.download().catch(() => undefined)
                      : onPairAgain(record)
                  }
                >
                  {row.blocked.action}
                </button>{" "}
                <button type="button" className="quiet" onClick={() => onForget(record)}>
                  forget
                </button>
              </>
            )}
          </p>
        )}
        {row.expiry === null ? null : (
          <p className="warning">
            {row.expiry} ·{" "}
            <button type="button" className="quiet" onClick={() => onPairAgain(record)}>
              pair again
            </button>
          </p>
        )}
        <nav className="tabs" aria-label="This deployment">
          {DEPLOYMENT_TABS.map((name) => (
            <button
              key={name}
              type="button"
              className={`tab${tab === name ? " current" : ""}`}
              {...(tab === name ? { "aria-current": "page" as const } : {})}
              onClick={() => onTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <DeploymentTabPanel
          tab={tab}
          reading={row.reading}
          connection={connection}
          config={config}
          now={now}
          frozen={row.frozen || row.tone === "disconnected"}
          empty={
            <p className="muted">
              {row.tone === "blocked"
                ? "Nothing has been read from this deployment since the session stopped working."
                : "Nothing has been received from this deployment yet. The first event on the stream is its latest report."}
            </p>
          }
          overview={
            <>
              <section className="session-card">
                <h2>Session</h2>
                <p>
                  {record.scopes.map((scope) => (
                    <span key={scope} className="chip">
                      {scope}
                    </span>
                  ))}{" "}
                  <span className="muted">paired as {record.label}</span>{" "}
                  <button type="button" className="quiet" onClick={() => onSignOut(record)}>
                    sign out
                  </button>
                </p>
              </section>
              <RemoteDevices
                record={record}
                client={client}
                now={now}
                tampered={section?.tampered === true}
                counts={section?.sessions ?? null}
                blocked={row.tone === "blocked"}
                onSignOut={() => onSignOut(record)}
                revoke={(sessionId) => bridge.remotes.revoke(record.deploymentId, sessionId)}
              />
            </>
          }
          writes={{
            config: <RemoteConfigEdit client={client} config={config} operate={operate} />,
            secrets: <RemoteSecretForm client={client} operate={operate} />,
            doctor: <RemoteRunDoctor client={client} operate={operate} />,
          }}
        />
      </div>
    </main>
  );
}

/** The Devices panel on a remote route: read over the API, revoked over it. */
function RemoteDevices({
  record,
  client,
  now,
  tampered,
  counts,
  blocked,
  onSignOut,
  revoke,
}: {
  record: RemoteRecord;
  client: ReturnType<typeof createRemoteClient>;
  now: Date;
  tampered: boolean;
  counts: { active: number; expired: number } | null;
  blocked: boolean;
  onSignOut: () => void;
  /** `DELETE /api/sessions/:id`, with the bearer added in main. */
  revoke: (sessionId: string) => Promise<RevokeOutcome>;
}) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [self, setSelf] = useState<string | null>(record.sessionId);
  const [trouble, setTrouble] = useState<string | null>(null);
  const operate = canOperate(record);

  const read = (): void => {
    client.sessions().then(
      (listed) => {
        setRows(listed.sessions);
        setSelf(listed.self);
        setTrouble(null);
      },
      (error: unknown) => {
        // A read session may not list; the panel says so and shows nothing.
        setRows([]);
        setTrouble(requestTrouble(error));
      },
    );
  };
  useEffect(() => {
    if (blocked || !operate) {
      setRows([]);
      return;
    }
    read();
    // The client is rebuilt per render; the list is read per record and tone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.deploymentId, record.reachability, operate, blocked]);

  return (
    <DevicesPanel
      rows={rows}
      self={self}
      canOperate={operate}
      tampered={tampered}
      counts={counts}
      now={now}
      blocked={blocked}
      trouble={
        !operate && !blocked
          ? "The list needs operate; this device paired with read only. Your own session is above."
          : trouble
      }
      note="Revoking needs operate; your own row signs out instead. pairedAs is the Tailscale login Serve supplied at pair time, information only; the host arm has none."
      onSignOut={onSignOut}
      onRevoke={(sessionId) => {
        revoke(sessionId).then(
          (outcome) => {
            const said = revokeLine(outcome);
            if (said === null) read();
            else setTrouble(said);
          },
          (error: unknown) => setTrouble(requestTrouble(error)),
        );
      }}
    />
  );
}

/** One revoke, as its one-line answer: null when it went, else why not. */
export function revokeLine(outcome: RevokeOutcome): string | null {
  switch (outcome.outcome) {
    case "revoked":
      return null;
    case "revoke-self":
      return "That is this device's own session: sign out instead of revoking it.";
    case "not-found":
      return "That session is already gone.";
    case "needs-operate":
      return NEEDS_OPERATE;
    case "failed":
      return outcome.detail;
  }
}

/** One field of the root config, changed over the API (#503). */
function RemoteConfigEdit({
  client,
  config,
  operate,
}: {
  client: ReturnType<typeof createRemoteClient>;
  config: ConfigReading | null;
  operate: boolean;
}) {
  const [field, setField] = useState("");
  const [literal, setLiteral] = useState("");
  const [receipt, setReceipt] = useState<EditReceipt | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (config === null || config.kind === "absent") {
    return <p className="muted">The report carries no config section to edit against.</p>;
  }
  const file = config;
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    let value;
    try {
      value = readLiteral(literal);
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error));
      return;
    }
    setBusy(true);
    setTrouble(null);
    client.configSet({ path: field.trim(), value, fingerprint: file.fingerprint }).then(
      (answer) => {
        setBusy(false);
        setReceipt(answer);
      },
      (error: unknown) => {
        setBusy(false);
        setTrouble(requestTrouble(error));
      },
    );
  }
  return (
    <>
      <h2>Change one field</h2>
      <p className="muted">
        Sent to the deployment over the API against the fingerprint this report carries; the
        deployment refuses it as stale when the file has moved since.
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
        <button
          type="submit"
          disabled={!operate || busy || field.trim().length === 0}
          title={operate ? undefined : NEEDS_OPERATE}
        >
          Set
        </button>
        {operate ? null : <span className="muted">{NEEDS_OPERATE}</span>}
      </form>
      {trouble === null ? null : <p className="refusal">{trouble}</p>}
      {receipt === null ? null : <ReceiptPanel receipt={receipt} />}
    </>
  );
}

/** One secret, set or cleared over the API. The value is in the body and nowhere else. */
function RemoteSecretForm({
  client,
  operate,
}: {
  client: ReturnType<typeof createRemoteClient>;
  operate: boolean;
}) {
  const [tenant, setTenant] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [receipt, setReceipt] = useState<RemoteSecretReceipt | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  function send(clear: boolean): void {
    setBusy(true);
    setTrouble(null);
    client.secretSet({ tenant: tenant.trim(), key: key.trim(), value: clear ? null : value }).then(
      (answer) => {
        setBusy(false);
        setReceipt(answer);
      },
      (error: unknown) => {
        setBusy(false);
        setTrouble(requestTrouble(error));
      },
    );
    // Emptied now: the request has the value, and a box still holding a token
    // is a box that can be read over a shoulder.
    setValue("");
  }
  return (
    <>
      <h2>Set a secret</h2>
      <p className="muted">
        The value goes to the deployment over the API, through this machine&apos;s Tailscale, and
        into the tenant&apos;s store. Nothing is kept here.
      </p>
      <form
        className="verbs"
        onSubmit={(event) => {
          event.preventDefault();
          send(false);
        }}
      >
        <input
          aria-label="Tenant"
          className="mono"
          placeholder="owner/repo"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
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
        <button
          type="submit"
          disabled={
            !operate ||
            busy ||
            key.trim().length === 0 ||
            tenant.trim().length === 0 ||
            value.length === 0
          }
          title={operate ? undefined : NEEDS_OPERATE}
        >
          Set
        </button>
        <button
          type="button"
          className="quiet"
          disabled={!operate || busy || key.trim().length === 0 || tenant.trim().length === 0}
          title={operate ? undefined : NEEDS_OPERATE}
          onClick={() => send(true)}
        >
          Clear
        </button>
        {operate ? null : <span className="muted">{NEEDS_OPERATE}</span>}
      </form>
      {trouble === null ? null : <p className="refusal">{trouble}</p>}
      {receipt === null ? null : (
        <p className={receipt.outcome === "written" ? "outcome" : "refusal"}>
          {receipt.outcome} — {receipt.detail}
        </p>
      )}
    </>
  );
}

/** Run doctor over the API. The press asks; the report answers. */
function RemoteRunDoctor({
  client,
  operate,
}: {
  client: ReturnType<typeof createRemoteClient>;
  operate: boolean;
}) {
  const [answer, setAnswer] = useState<DoctorRunResponse | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="run-doctor">
      <div className="verbs">
        <button
          type="button"
          disabled={!operate || busy}
          title={operate ? undefined : NEEDS_OPERATE}
          onClick={() => {
            setBusy(true);
            setTrouble(null);
            client.doctorRun().then(
              (said) => {
                setBusy(false);
                setAnswer(said);
              },
              (error: unknown) => {
                setBusy(false);
                setTrouble(requestTrouble(error));
              },
            );
          }}
        >
          Run doctor
        </button>
        {operate ? null : <span className="muted">{NEEDS_OPERATE}</span>}
      </div>
      {answer === null ? null : (
        <p className="outcome">
          {answer.outcome === "started"
            ? "a run started — the report will arrive when it finishes"
            : answer.outcome === "joined"
              ? "joined the run already under way"
              : `refused${answer.detail === undefined ? "" : `: ${answer.detail}`}`}
        </p>
      )}
      {trouble === null ? null : <p className="refusal">{trouble}</p>}
    </div>
  );
}
