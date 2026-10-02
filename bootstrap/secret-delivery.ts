// A secret arriving from the console (#550, decided in #504 and #514) — the one
// place a sealed envelope is opened.
//
// The console encrypted to this deployment's box key. The relay carried the
// envelope and could not read it. Here, and only here, the private half exists:
// the envelope opens, the value goes into the tenant's secret store, and the
// ledger records who asked. The plaintext lives in one local variable between
// those two steps and is never logged, never put in a receipt, and never in an
// error message — a refusal says which key and why, and nothing about what it
// held.
//
// **The request is validated before it is opened.** The tenant has to exist,
// and the key has to be one that tenant may set — the same derived set
// `phoebe secret set` checks, refused with the same sentence, because a console
// and a shell disagreeing about what is settable would make one of them a lie.
// Only then is anything decrypted.
//
// **The AAD is the request.** `keyFingerprint ‖ tenant ‖ key ‖ editId` are
// bound into the envelope by the browser and rebuilt here from the deployment's
// own fingerprint and the request's own fields, so an envelope replayed at a
// second deployment, tenant, key name or id does not open. That is why the
// refusal for a failed open names all four: GCM cannot say which of them moved,
// and neither can this.
//
// **The walk ends at `written` or `refused`** (#503). Not "in use": pickup is a
// child relaunch the supervisor performs on its own clock, driven by the
// pipeline fingerprint that counts the store. What an operator watches after a
// receipt is the report — the inventory's provenance moving to `store`, and the
// doctor run a successful write triggers.

import { openSecret } from "../src/contracts/secret-envelope.mjs";
import type { SecretEnvelope } from "../src/contracts/secret-envelope.mjs";
import type { SecretOutcome, SecretReceiptDetail } from "../src/contracts/secrets.ts";
import { resolveSecretTarget, type SecretTarget } from "../src/secret-command.ts";
import { clearSecret, offCatalogueRefusal, setSecret } from "../src/secret-store.ts";
import type { RequestAnswer } from "./relay-link.ts";

/** What the deployment needs to answer a secret request. */
export type SecretDeliveryDeps = {
  /** The deployment's root config: where tenant resolution starts. */
  configPath: string;
  /** The data volume's mount point — every tenant's store hangs off it. */
  dataBase: string;
  processEnv: NodeJS.ProcessEnv;
  /**
   * The box key's private half and the fingerprint the envelope was bound to,
   * read at request time rather than handed over once: a deployment that paired
   * mid-run can be sent a secret without waiting for a restart.
   */
  key: () => { boxPrivateKey: Uint8Array; fingerprint: string } | null;
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

/** One secret request, as far as the transport checked it. */
export type SecretRequest = {
  /** The request id, which is also the ledger entry's id and the AAD's `editId`. */
  id: string;
  frame: Record<string, unknown>;
};

/**
 * Answer one `secret-set` request. Never throws: every path returns a receipt,
 * because a console waiting on one has nothing else to go on.
 */
export async function deliverSecret(
  request: SecretRequest,
  deps: SecretDeliveryDeps,
): Promise<RequestAnswer> {
  const tenantName = stringField(request.frame, "tenant");
  const key = stringField(request.frame, "key");
  const action = stringField(request.frame, "action");
  const by = stringField(request.frame, "by") ?? "";
  if (tenantName === null || key === null) {
    return refused(tenantName ?? "", key ?? "", "A secret request needs a tenant and a key.");
  }
  if (action !== "set" && action !== "clear") {
    return refused(tenantName, key, `\`${String(action)}\` is not a secret action.`);
  }

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

  if (action === "clear") {
    const { cleared } = clearSecret({ stateDir: target.stateDir, key, by, id: request.id });
    deps.log?.(
      `[phoebe] relay: ${by} cleared ${key} for ${target.slug} (edit ${request.id})` +
        `${cleared ? "" : " — it was not in the store"}.`,
    );
    if (cleared) {
      deps.onWritten?.({ tenant: target.slug, key, editId: request.id, by });
    }
    return written(
      target.slug,
      key,
      request.id,
      cleared
        ? `Cleared ${key}. The tenant's .env or the ambient value governs again — there is no tombstone.`
        : `${key} was not in ${target.slug}'s store, so there was nothing to clear.`,
    );
  }

  const identity = deps.key();
  if (identity === null) {
    return refused(
      tenantName,
      key,
      "This deployment has no box key on its volume, so nothing can be sealed to it. " +
        "It has not completed a handshake since the key file gained one.",
    );
  }
  const envelope = parseEnvelope(request.frame["envelope"]);
  if (envelope === null) {
    return refused(tenantName, key, "The request carried no readable envelope.");
  }

  let value: string;
  try {
    value = await openSecret({
      boxPrivateKey: identity.boxPrivateKey,
      aad: {
        keyFingerprint: identity.fingerprint,
        tenant: tenantName,
        key,
        editId: request.id,
      },
      envelope,
    });
  } catch (error) {
    // The envelope's own message already names the four things it binds. It
    // says nothing about the bytes it was carrying, which is the property that
    // makes it safe to hand to a console.
    return refused(tenantName, key, messageOf(error));
  }
  if (value.length === 0) {
    return refused(
      tenantName,
      key,
      `A blank is not a secret. Clearing ${key} is how you hand it back to the .env.`,
    );
  }

  const edit = setSecret({ stateDir: target.stateDir, key, value, by, id: request.id });
  deps.log?.(`[phoebe] relay: ${by} set ${key} for ${target.slug} (edit ${edit.id}).`);
  deps.onWritten?.({ tenant: target.slug, key, editId: edit.id, by });
  return written(
    target.slug,
    key,
    edit.id,
    `Wrote ${key} to ${target.slug}'s store. The pipeline that reads it relaunches on the ` +
      `supervisor's next poll; doctor is running now.`,
  );
}

/**
 * Tenant resolution as `phoebe secret` does it — a workspace root demands a
 * named tenant, a solo deployment is its own — so the console cannot reach a
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

/**
 * The envelope, as the wire carries it: the JSON of a `SecretEnvelope`, opaque
 * to everything between the browser and here. Only the outer shape is checked —
 * whether the parts are a key, an IV and a ciphertext is the envelope's own
 * question, and it answers it by failing to open.
 */
function parseEnvelope(field: unknown): SecretEnvelope | null {
  if (typeof field !== "string" || field.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(field);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as SecretEnvelope;
}

function stringField(frame: Record<string, unknown>, name: string): string | null {
  const value = frame[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function written(
  tenant: string,
  key: string,
  editId: string,
  detail: string,
): { outcome: SecretOutcome; detail: SecretReceiptDetail } {
  return { outcome: "written", detail: { tenant, key, editId, detail } };
}

function refused(
  tenant: string,
  key: string,
  detail: string,
): { outcome: SecretOutcome; detail: SecretReceiptDetail } {
  return { outcome: "refused", detail: { tenant, key, detail } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
