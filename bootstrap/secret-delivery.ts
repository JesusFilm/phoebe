// A secret arriving over the deployment API (map #690; decided in #504, #514
// and #694) — one plain-JSON body, the same gate `phoebe secret set` applies,
// and the one place a value goes from the wire into the store.
//
// Serve's TLS is the wrapping. The relay's envelope died with the box key; what
// reaches here is `{ tenant, key, value | null }` plus the `by` the listener
// stamped from the session. The plaintext lives in one local variable between
// the body and the store, and is never logged, never put in a receipt, and
// never in an error message — a refusal says which key and why, and nothing
// about what it held.
//
// **The request is validated before anything is written.** The tenant has to
// exist, and the key has to be one that tenant may set — the same derived set
// `phoebe secret set` checks, refused with the same sentence, because a console
// and a shell disagreeing about what is settable would make one of them a lie.
//
// **The walk ends at `written` or `refused`** (#503). Not "in use": pickup is a
// child relaunch the supervisor performs on its own clock, driven by the
// pipeline fingerprint that counts the store. What an operator watches after a
// receipt is the report — the inventory's provenance moving to `store`, and the
// doctor run a successful write triggers.

import { resolveSecretTarget, type SecretTarget } from "../src/secret-command.ts";
import { clearSecret, offCatalogueRefusal, setSecret } from "../src/secret-store.ts";
import type { SecretResponse } from "./remote-api.ts";

/** What the deployment needs to answer a secret request. */
export type SecretDeliveryDeps = {
  /** The deployment's root config: where tenant resolution starts. */
  configPath: string;
  /** The data volume's mount point — every tenant's store hangs off it. */
  dataBase: string;
  processEnv: NodeJS.ProcessEnv;
  /** Injected so a test resolves a tenant without a workspace on disk. */
  resolveTarget?: (tenant: string) => Promise<SecretTarget>;
  /**
   * A write landed. Where the doctor run and the inventory refresh hang off
   * (#507 §6): setting a key is the moment an operator wants "did it work"
   * answered, and those two are what answer it.
   */
  onWritten?: (edit: { tenant: string; key: string; editId: string; by: string }) => void;
  /** Operator-facing lines. Never carries a value. */
  log?: (message: string) => void;
};

/** One secret request, as the listener checked and stamped it. */
export type SecretRequest = {
  /** The request id, which is also the ledger entry's id. */
  id: string;
  tenant: string;
  key: string;
  /** Null clears the key. */
  value: string | null;
  /** Who asked, from the session. */
  by: string;
};

/**
 * Answer one secret request. Never throws: every path returns a receipt,
 * because a device waiting on one has nothing else to go on.
 */
export async function deliverSecret(
  request: SecretRequest,
  deps: SecretDeliveryDeps,
): Promise<SecretResponse> {
  const { tenant: tenantName, key, by } = request;
  let target: SecretTarget;
  try {
    target = await (deps.resolveTarget ?? defaultResolveTarget(deps))(tenantName);
  } catch (error) {
    return refused(tenantName, key, messageOf(error));
  }
  // The same gate `phoebe secret set` applies, with the same sentence: the App
  // credentials, the `PHOEBE_*` settings, the git identity, and anything no
  // work kind declares.
  if (!target.settable.includes(key)) {
    return refused(tenantName, key, offCatalogueRefusal(key, target.settable));
  }

  if (request.value === null) {
    const { cleared } = clearSecret({ stateDir: target.stateDir, key, by, id: request.id });
    deps.log?.(
      `[phoebe] remote: ${by} cleared ${key} for ${target.slug} (edit ${request.id})` +
        `${cleared ? "" : " — it was not in the store"}.`,
    );
    if (cleared) deps.onWritten?.({ tenant: target.slug, key, editId: request.id, by });
    return {
      outcome: "written",
      tenant: target.slug,
      key,
      editId: request.id,
      detail: cleared
        ? `Cleared ${key}. The tenant's .env or the ambient value governs again — there is no tombstone.`
        : `${key} was not in ${target.slug}'s store, so there was nothing to clear.`,
    };
  }

  if (request.value.length === 0) {
    return refused(
      tenantName,
      key,
      `A blank is not a secret. Clearing ${key} is how you hand it back to the .env.`,
    );
  }

  const edit = setSecret({
    stateDir: target.stateDir,
    key,
    value: request.value,
    by,
    id: request.id,
  });
  deps.log?.(`[phoebe] remote: ${by} set ${key} for ${target.slug} (edit ${edit.id}).`);
  deps.onWritten?.({ tenant: target.slug, key, editId: edit.id, by });
  return {
    outcome: "written",
    tenant: target.slug,
    key,
    editId: edit.id,
    detail:
      `Wrote ${key} to ${target.slug}'s store. The pipeline that reads it relaunches on the ` +
      `supervisor's next poll; doctor is running now.`,
  };
}

/**
 * Tenant resolution as `phoebe secret` does it — a workspace root demands a
 * named tenant, a solo deployment is its own — so a device cannot reach a
 * tenant the CLI would refuse to.
 */
function defaultResolveTarget(deps: SecretDeliveryDeps): (tenant: string) => Promise<SecretTarget> {
  return (tenant) =>
    resolveSecretTarget({
      configPath: deps.configPath,
      dataBase: deps.dataBase,
      processEnv: deps.processEnv,
      tenant,
    });
}

function refused(tenant: string, key: string, detail: string): SecretResponse {
  return { outcome: "refused", tenant, key, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
