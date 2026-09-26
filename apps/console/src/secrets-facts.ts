// The secrets tab's facts (#550, decided in #504 and #514): what the report
// says about a tenant's keys, whether this console may set each one, and — when
// a request cannot be delivered — the command an operator runs on the host
// instead.
//
// Pure, and apart from the component, like every other derivation in this app:
// the deployment already decided which keys exist, where each value came from
// and which ones are settable (src/secret-inventory.ts). Nothing here recomputes
// any of that. What it adds is the console's own two questions — *can this
// browser send a set at all*, and *what do I tell the operator when it cannot* —
// neither of which the deployment can answer, because both are about the relay
// and the connection.
//
// **Sealing happens here, in the page.** `sealSecret` runs against the box key
// the relay served on the deployment's row, and the plaintext never leaves the
// function it was typed into: what goes to the relay is the envelope. The AAD
// binds the deployment's fingerprint, the tenant, the key and the edit id, so
// the same envelope cannot be re-sent as a different edit or at a different
// deployment (#514 §6).

import { sealSecret } from "phoebe-agent/contracts";
import type {
  RelayDeploymentRow,
  SecretListing,
  SecretReceiptDetail,
  TenantSecrets,
} from "phoebe-agent/contracts";
import type { RelayClient, SecretReceipt } from "./relay-client.ts";
import type { RowFacts } from "./facts.ts";

/**
 * The secrets section of one deployment's report, or null when this console has
 * nothing to read: no report, a report it cannot read, or a report from an
 * engine that predates the section.
 *
 * Null is not "this deployment has no secrets". The tab says which of the two
 * it is looking at, because an empty page and an unanswered question look
 * identical and are not.
 */
export function secretsOf(facts: RowFacts): TenantSecrets[] | null {
  if (facts.reading.kind !== "read") return null;
  const section = facts.reading.report.secrets;
  if (section === undefined || !Array.isArray(section.tenants)) return null;
  return section.tenants as TenantSecrets[];
}

/** When this console last heard what the secrets are. Null with no section. */
export function secretsTakenAt(facts: RowFacts): string | null {
  if (facts.reading.kind !== "read") return null;
  return facts.reading.report.secrets?.updatedAt ?? null;
}

/**
 * Why this console cannot set `listing` on this deployment, or null when it
 * can. Four reasons, and they are asked in the order an operator would ask
 * them: the key itself, then the tenant, then the connection, then the key
 * material.
 *
 * The first is the deployment's own verdict, carried verbatim — the same
 * sentence `phoebe secret set` refuses with, so the page cannot invent a rule
 * the deployment does not have.
 */
export function whyNotSettable(
  listing: SecretListing,
  tenant: TenantSecrets,
  row: RelayDeploymentRow,
): string | null {
  if (listing.unsettable !== undefined) return listing.unsettable;
  if (tenant.error !== null) {
    return `This tenant's settings are unknown — ${tenant.error}`;
  }
  if (row.state !== "connected") {
    return (
      `This deployment is ${row.state}. A set is delivered down its live connection and ` +
      `nothing is queued, so there is nothing to send it through right now.`
    );
  }
  if (row.boxKey === null) {
    return (
      `This deployment has published no box key, so nothing can be encrypted to it. ` +
      `It paired with a relay older than the key, and gains one the next time it reconnects.`
    );
  }
  return null;
}

/**
 * The command that does this on the host, for an operator whose request could
 * not be delivered — or who would rather not go through a relay at all (#550).
 *
 * The value is on stdin and never in the argument list, which is the store's own
 * rule: an argument lands in shell history and in `/proc/<pid>/cmdline`, where a
 * co-tenant sharing the container's uid can read it.
 */
export function stdinCommand(opts: {
  key: string;
  tenant: string;
  action: "set" | "clear";
}): string {
  const tenantFlag = ` --tenant ${opts.tenant}`;
  if (opts.action === "clear") {
    return `docker compose exec phoebe phoebe secret clear ${opts.key}${tenantFlag}`;
  }
  return (
    `printf %s "$${opts.key}" | docker compose exec -T phoebe ` +
    `phoebe secret set ${opts.key}${tenantFlag}`
  );
}

/** What the tab shows once a receipt is back. */
export type SecretResult = {
  key: string;
  tenant: string;
  outcome: string;
  /** The sentence to show. Never a value: no receipt has ever carried one. */
  detail: string;
  /**
   * The request never reached the deployment, so the walk ends here and the
   * host command is the way through. `undelivered` is the relay's own word for
   * a socket that closed with the request in flight (#506 §8).
   */
  undelivered: boolean;
};

/**
 * Seal a value to this deployment and send it, or send a clear. The plaintext
 * exists as an argument to this function and in the envelope it produces, and
 * goes nowhere else — not into the request body, not into the result.
 *
 * `editId` is generated by the caller and bound into the envelope, so a second
 * press is a second edit and a captured envelope cannot be replayed as one.
 */
export async function sendSecret(opts: {
  client: RelayClient;
  row: RelayDeploymentRow;
  tenant: string;
  key: string;
  /** The value to seal, or null to clear the key. */
  value: string | null;
  editId: string;
}): Promise<SecretResult> {
  const { row, tenant, key } = opts;
  const base = { key, tenant };
  if (opts.value === null) {
    return resultOf(
      base,
      await opts.client.setSecret({
        fingerprint: row.fingerprint,
        tenant,
        key,
        action: "clear",
        id: opts.editId,
      }),
    );
  }
  if (row.boxKey === null) {
    throw new Error("This deployment has published no box key, so nothing can be sealed to it.");
  }
  const envelope = await sealSecret({
    boxKey: row.boxKey,
    aad: { keyFingerprint: row.fingerprint, tenant, key, editId: opts.editId },
    plaintext: opts.value,
  });
  return resultOf(
    base,
    await opts.client.setSecret({
      fingerprint: row.fingerprint,
      tenant,
      key,
      action: "set",
      id: opts.editId,
      envelope: JSON.stringify(envelope),
    }),
  );
}

/**
 * The receipt as a line on the page. The deployment's own wording is preferred
 * wherever it sent one — it knows which of its rules refused, and this page does
 * not — and the relay's `undelivered` gets the sentence the relay cannot write,
 * because the relay does not know what the request was for.
 */
function resultOf(base: { key: string; tenant: string }, receipt: SecretReceipt): SecretResult {
  const undelivered = receipt.outcome === "undelivered";
  return {
    ...base,
    outcome: receipt.outcome,
    undelivered,
    detail: undelivered
      ? "The deployment's connection closed before the request reached it. Nothing was queued " +
        "and nothing was written; re-issue it, or run the command below on the host."
      : (detailText(receipt.detail) ?? `The deployment answered ${receipt.outcome}.`),
  };
}

function detailText(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (typeof detail !== "object" || detail === null) return null;
  const text = (detail as Partial<SecretReceiptDetail>).detail;
  return typeof text === "string" ? text : null;
}
