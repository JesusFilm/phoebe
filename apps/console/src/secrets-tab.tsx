// The secrets tab (#550, decided in #504 and #514).
//
// **Presence and provenance, and nothing else.** No value, no last four, no
// hash, no length. Every field on screen comes from the deployment's own
// inventory, which carries none of those either — so there is nothing here to
// leak, by design rather than by discipline.
//
// **Set is a one-way door.** An operator types a value, the browser seals it to
// the deployment's box key, and what leaves the page is an envelope the relay
// cannot open. Nothing reads a value back afterwards, including the person who
// just typed it: the page's answer to "did that work" is the provenance moving
// to `store` and the doctor run the deployment starts, not a readback.
//
// **A key that cannot be set says why, in place.** The App credentials are
// deployment scope and no relay may set one; a key no work kind declares is off
// the catalogue; a dark deployment cannot be reached at all. Each is the
// sentence the deployment itself would refuse with, next to the key it is about,
// rather than a disabled button with no explanation.
//
// **The walk ends at `written`, `refused` or `undelivered`.** The first two are
// the deployment's words. The third is the relay's, and it is the one that hands
// the operator something to do: the `phoebe secret` command that does the same
// thing over a shell on the host, with the value on stdin where it belongs.

import { useState } from "react";
import type { RelayDeploymentRow, SecretListing, TenantSecrets } from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import type { RowFacts } from "./facts.ts";
import type { RelayClient } from "./relay-client.ts";
import {
  secretsOf,
  secretsTakenAt,
  sendSecret,
  stdinCommand,
  whyNotSettable,
  type SecretResult,
} from "./secrets-facts.ts";

/** Which key's form is open, and what has been typed into it. */
type Editing = { tenant: string; key: string; value: string; sending: boolean };

export function SecretsTab({
  facts,
  client,
  now,
  newEditId = () => crypto.randomUUID(),
}: {
  facts: RowFacts;
  client: RelayClient;
  now: Date;
  /** Injected so a test can pin the edit id the AAD is bound to. */
  newEditId?: () => string;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [result, setResult] = useState<SecretResult | null>(null);
  const tenants = secretsOf(facts);
  const takenAt = secretsTakenAt(facts);

  if (tenants === null) {
    return (
      <p className="muted">
        This deployment&apos;s report carries no secrets section. Either it has not pushed one since
        it was upgraded, or it is running an engine from before the section existed — not that it
        holds no secrets.
      </p>
    );
  }

  const send = (tenant: string, key: string, value: string | null): void => {
    setEditing((open) => (open === null ? null : { ...open, sending: true }));
    sendSecret({ client, row: facts.row, tenant, key, value, editId: newEditId() }).then(
      (outcome) => {
        setResult(outcome);
        setEditing(null);
      },
      (error: unknown) => {
        setResult({
          tenant,
          key,
          outcome: "refused",
          detail: error instanceof Error ? error.message : String(error),
          undelivered: false,
        });
        setEditing(null);
      },
    );
  };

  return (
    <>
      <p className="facts">
        Presence and provenance only — no value is ever shown, and none can be read back (#504).
        {takenAt === null ? null : ` Taken ${age(takenAt, now)} ago.`}
      </p>
      {result === null ? null : <Receipt result={result} />}
      {tenants.length === 0 ? (
        <p className="muted">
          This deployment declares no tenant, so there is no store to hold a secret.
        </p>
      ) : (
        tenants.map((tenant) => (
          <TenantSection
            key={tenant.tenant}
            tenant={tenant}
            row={facts.row}
            editing={editing}
            onOpen={(key) => {
              setResult(null);
              setEditing({ tenant: tenant.tenant, key, value: "", sending: false });
            }}
            onType={(value) => setEditing((open) => (open === null ? null : { ...open, value }))}
            onCancel={() => setEditing(null)}
            onSend={(key, value) => send(tenant.tenant, key, value)}
          />
        ))
      )}
    </>
  );
}

function TenantSection({
  tenant,
  row,
  editing,
  onOpen,
  onType,
  onCancel,
  onSend,
}: {
  tenant: TenantSecrets;
  row: RelayDeploymentRow;
  editing: Editing | null;
  onOpen: (key: string) => void;
  onType: (value: string) => void;
  onCancel: () => void;
  onSend: (key: string, value: string | null) => void;
}) {
  return (
    <>
      <h2>{tenant.tenant}</h2>
      {tenant.error !== null ? (
        <p className="bad">
          This tenant&apos;s settings are unknown — {tenant.error}. Its store is untouched; nothing
          can be set until the tenant loads.
        </p>
      ) : null}
      {tenant.keys.length === 0 ? (
        <p className="muted">
          No key to show. This tenant&apos;s work kinds declare none, and its store holds none.
        </p>
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>key</th>
              <th>presence</th>
              <th>from</th>
              <th>last set</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tenant.keys.map((listing) => (
              <KeyRow
                key={listing.key}
                listing={listing}
                tenant={tenant}
                row={row}
                editing={
                  editing !== null &&
                  editing.tenant === tenant.tenant &&
                  editing.key === listing.key
                    ? editing
                    : null
                }
                onOpen={() => onOpen(listing.key)}
                onType={onType}
                onCancel={onCancel}
                onSend={(value) => onSend(listing.key, value)}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function KeyRow({
  listing,
  tenant,
  row,
  editing,
  onOpen,
  onType,
  onCancel,
  onSend,
}: {
  listing: SecretListing;
  tenant: TenantSecrets;
  row: RelayDeploymentRow;
  editing: Editing | null;
  onOpen: () => void;
  onType: (value: string) => void;
  onCancel: () => void;
  onSend: (value: string | null) => void;
}) {
  const refusal = whyNotSettable(listing, tenant, row);
  return (
    <>
      <tr>
        <th scope="row" className="mono">
          {listing.key}
        </th>
        <td>
          {listing.present ? "set" : <span className="muted">not set</span>}
          {listing.shadowed === true ? <span className="chip warn">shadows the .env</span> : null}
        </td>
        <td className="muted">{sourceLine(listing)}</td>
        <td className="muted">
          {listing.setAt === undefined ? "—" : `${listing.setAt} by ${listing.by ?? "unknown"}`}
        </td>
        <td>
          {refusal !== null ? (
            <span className="muted">not settable here</span>
          ) : editing !== null ? null : (
            <>
              <button type="button" onClick={onOpen}>
                Set
              </button>
              {listing.source === "store" ? (
                <button type="button" onClick={() => onSend(null)}>
                  Clear
                </button>
              ) : null}
            </>
          )}
        </td>
      </tr>
      {refusal === null ? null : (
        <tr>
          <td colSpan={5} className="facts">
            {refusal}
          </td>
        </tr>
      )}
      {editing === null ? null : (
        <tr>
          <td colSpan={5}>
            <SetForm
              listing={listing}
              tenant={tenant.tenant}
              editing={editing}
              onType={onType}
              onCancel={onCancel}
              onSend={onSend}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The one field on this page that takes a value. It is a password input so a
 * shoulder does not read it, and the value it holds is sealed in this browser
 * and dropped — the form closes on the receipt and there is nothing to reopen.
 */
function SetForm({
  listing,
  tenant,
  editing,
  onType,
  onCancel,
  onSend,
}: {
  listing: SecretListing;
  tenant: string;
  editing: Editing;
  onType: (value: string) => void;
  onCancel: () => void;
  onSend: (value: string) => void;
}) {
  return (
    <form
      className="secret-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (editing.value.length > 0) onSend(editing.value);
      }}
    >
      <label htmlFor={`secret-${listing.key}`}>
        New value for <span className="mono">{listing.key}</span>
      </label>
      <input
        id={`secret-${listing.key}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={editing.value}
        disabled={editing.sending}
        onChange={(event) => onType(event.target.value)}
      />
      <div className="secret-actions">
        <button type="submit" disabled={editing.sending || editing.value.length === 0}>
          {editing.sending ? "Sending…" : "Seal and send"}
        </button>
        <button type="button" onClick={onCancel} disabled={editing.sending}>
          Cancel
        </button>
      </div>
      <p className="facts">
        Encrypted in this browser to this deployment&apos;s key. The relay carries it sealed and
        cannot read it; the deployment opens it on arrival. Nothing shows it again.
      </p>
      <p className="facts">
        On the host instead:{" "}
        <code>{stdinCommand({ key: listing.key, tenant, action: "set" })}</code>
      </p>
    </form>
  );
}

/** What a receipt says, and what to do about it. */
function Receipt({ result }: { result: SecretResult }) {
  return (
    <section className={`panel receipt ${result.outcome}`} aria-label="Receipt">
      <p className="lead">
        <span className="mono">{result.key}</span> — {result.outcome}
      </p>
      <p className="facts">{result.detail}</p>
      {result.undelivered ? (
        <p className="facts">
          On the host:{" "}
          <code>{stdinCommand({ key: result.key, tenant: result.tenant, action: "set" })}</code>
        </p>
      ) : null}
    </section>
  );
}

/** Where the value a child would hold comes from, in words rather than a code. */
function sourceLine(listing: SecretListing): string {
  switch (listing.source) {
    case "store":
      return "the secret store";
    case "tenantEnv":
      return "the tenant's .env";
    case "process":
      return "the container's environment";
    default:
      return "nowhere — nothing sets it";
  }
}
