// A secret arriving from the console (#550): the envelope the browser sealed,
// opened here and nowhere else, and every refusal that stops it short of the
// store.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { sealSecret } from "../src/contracts/secret-envelope.mjs";
import type { SecretReceiptDetail } from "../src/contracts/secrets.ts";
import { readSecretEdits, readSecretStore, setSecret } from "../src/secret-store.ts";
import { generateDeploymentKey } from "./relay-key.ts";
import { deliverSecret, type SecretDeliveryDeps } from "./secret-delivery.ts";

const TENANT_CONFIG = `const config = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  providerEnv: { claude: "ANTHROPIC_API_KEY" },
};
export default config;
`;

const OPERATOR = "ada@example.test";
const KEY = generateDeploymentKey();

let root: string;
let dataBase: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-secret-delivery-"));
  dataBase = join(root, "data");
  mkdirSync(join(dataBase, "acme", "widget", "state"), { recursive: true });
  writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const stateDir = (): string => join(dataBase, "acme", "widget", "state");

const written: { tenant: string; key: string; editId: string; by: string }[] = [];
const logs: string[] = [];

function deps(overrides: Partial<SecretDeliveryDeps> = {}): SecretDeliveryDeps {
  return {
    configPath: join(root, "phoebe.config.ts"),
    dataBase,
    processEnv: { PHOEBE_DATA_DIR: dataBase },
    key: () => ({ boxPrivateKey: KEY.boxPrivateKey, fingerprint: KEY.fingerprint }),
    onWritten: (edit) => written.push(edit),
    log: (message) => logs.push(message),
    ...overrides,
  };
}

/** Seal a value the way the browser does, to the deployment's published key. */
async function envelopeFor(opts: {
  id: string;
  key: string;
  value: string;
  tenant?: string;
  fingerprint?: string;
  boxKey?: string;
}): Promise<string> {
  return JSON.stringify(
    await sealSecret({
      boxKey: opts.boxKey ?? KEY.boxKey,
      aad: {
        keyFingerprint: opts.fingerprint ?? KEY.fingerprint,
        tenant: opts.tenant ?? "acme/widget",
        key: opts.key,
        editId: opts.id,
      },
      plaintext: opts.value,
    }),
  );
}

/** A `set` request as the relay forwards it, `by` stamped from the session. */
async function setRequest(opts: {
  id: string;
  key: string;
  value: string;
  tenant?: string;
  fingerprint?: string;
  boxKey?: string;
}) {
  return {
    id: opts.id,
    frame: {
      tenant: opts.tenant ?? "acme/widget",
      key: opts.key,
      action: "set",
      envelope: await envelopeFor(opts),
      by: OPERATOR,
    },
  };
}

const detailOf = (answer: { detail?: unknown }): SecretReceiptDetail =>
  answer.detail as SecretReceiptDetail;

describe("a set that lands", () => {
  test("opens the envelope into the store and ends at `written`", async () => {
    const answer = await deliverSecret(
      await setRequest({ id: "edit-1", key: "ANTHROPIC_API_KEY", value: "sk-live" }),
      deps(),
    );

    expect(answer.outcome).toBe("written");
    expect(detailOf(answer).editId).toBe("edit-1");
    expect(readSecretStore(stateDir())["ANTHROPIC_API_KEY"]).toBe("sk-live");
  });

  test("the ledger records who asked, and the request id is the edit", async () => {
    // The relay stamps `by` from its own session and a console cannot choose
    // it, so this row is the audit trail for a value nobody can read back.
    await deliverSecret(
      await setRequest({ id: "edit-1", key: "ANTHROPIC_API_KEY", value: "sk-live" }),
      deps(),
    );

    expect(readSecretEdits(stateDir())).toEqual([
      { id: "edit-1", key: "ANTHROPIC_API_KEY", at: expect.any(String), by: OPERATOR },
    ]);
  });

  test("the ledger holds the key and never the value", async () => {
    await deliverSecret(
      await setRequest({ id: "edit-1", key: "ANTHROPIC_API_KEY", value: "sk-live-abcd" }),
      deps(),
    );
    expect(readFileSync(join(stateDir(), "secret-edits.json"), "utf8")).not.toContain("sk-live");
  });

  test("nor does the receipt, or the log line", async () => {
    // The two things that leave the container after a set. A value in either
    // would undo the whole design: the relay stores receipts and the host
    // collects the log.
    const answer = await deliverSecret(
      await setRequest({ id: "edit-1", key: "ANTHROPIC_API_KEY", value: "sk-live-abcd" }),
      deps(),
    );

    expect(JSON.stringify(answer)).not.toContain("sk-live");
    expect(logs.join("\n")).not.toContain("sk-live");
    expect(logs.join("\n")).toContain(`${OPERATOR} set ANTHROPIC_API_KEY`);
  });

  test("a set triggers the doctor run and the inventory refresh", async () => {
    written.length = 0;
    await deliverSecret(
      await setRequest({ id: "edit-1", key: "ANTHROPIC_API_KEY", value: "sk-live" }),
      deps(),
    );
    expect(written).toEqual([
      { tenant: "acme/widget", key: "ANTHROPIC_API_KEY", editId: "edit-1", by: OPERATOR },
    ]);
  });

  test("re-issuing the same edit id is idempotent, not a second value", async () => {
    // The relay queues nothing and replays nothing (#506 §8), so a re-issue is
    // an operator pressing the button again. Same id, same row.
    const request = await setRequest({ id: "edit-1", key: "GH_TOKEN", value: "ghp_one" });
    await deliverSecret(request, deps());
    await deliverSecret(request, deps());

    expect(readSecretEdits(stateDir())).toHaveLength(2);
    expect(new Set(readSecretEdits(stateDir()).map((edit) => edit.id))).toEqual(
      new Set(["edit-1"]),
    );
  });
});

describe("a clear", () => {
  test("removes the entry and leaves no tombstone", async () => {
    setSecret({ stateDir: stateDir(), key: "ANTHROPIC_API_KEY", value: "sk-live" });

    const answer = await deliverSecret(
      {
        id: "edit-2",
        frame: {
          tenant: "acme/widget",
          key: "ANTHROPIC_API_KEY",
          action: "clear",
          by: OPERATOR,
        },
      },
      deps(),
    );

    expect(answer.outcome).toBe("written");
    expect(detailOf(answer).detail).toMatch(/governs again/);
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("clearing what was never set says so rather than failing", async () => {
    const answer = await deliverSecret(
      {
        id: "edit-2",
        frame: { tenant: "acme/widget", key: "GH_TOKEN", action: "clear", by: OPERATOR },
      },
      deps(),
    );
    expect(answer.outcome).toBe("written");
    expect(detailOf(answer).detail).toMatch(/nothing to clear/);
  });

  test("and needs no envelope — there is no value to seal", async () => {
    setSecret({ stateDir: stateDir(), key: "GH_TOKEN", value: "ghp_one" });
    const answer = await deliverSecret(
      {
        id: "edit-2",
        frame: { tenant: "acme/widget", key: "GH_TOKEN", action: "clear", by: OPERATOR },
      },
      deps({ key: () => null }),
    );
    expect(answer.outcome).toBe("written");
    expect(readSecretStore(stateDir())).toEqual({});
  });
});

describe("what is refused", () => {
  test("a deployment-scope key, with the reason a person can act on", async () => {
    const answer = await deliverSecret(
      await setRequest({ id: "edit-1", key: "GH_APP_PRIVATE_KEY", value: "-----BEGIN" }),
      deps(),
    );

    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/deployment-scope credential/);
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("a key no work kind declares", async () => {
    const answer = await deliverSecret(
      await setRequest({ id: "edit-1", key: "SOMETHING_ELSE", value: "whatever" }),
      deps(),
    );
    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/not a key this tenant reads/);
  });

  test("an envelope sealed to another deployment's box key", async () => {
    // The relay forwards what it is given and cannot check it. This is the
    // check: the private half is the only thing that can open an envelope, and
    // a stranger's envelope is not a secret meant for here.
    const stranger = generateDeploymentKey();
    const answer = await deliverSecret(
      await setRequest({
        id: "edit-1",
        key: "ANTHROPIC_API_KEY",
        value: "sk-live",
        boxKey: stranger.boxKey,
      }),
      deps(),
    );

    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/not sealed for this deployment/);
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("an envelope bound to a different edit id — a replay", async () => {
    // The AAD binds the id, so the envelope from one request cannot be re-sent
    // under another. Without it a captured envelope could be replayed forever.
    const original = await setRequest({ id: "edit-1", key: "GH_TOKEN", value: "ghp_one" });
    const replayed = { id: "edit-2", frame: original.frame };

    const answer = await deliverSecret(replayed, deps());

    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/not sealed for this deployment/);
  });

  test("an envelope bound to a different key name", async () => {
    const sealedForOther = await envelopeFor({ id: "edit-1", key: "GH_TOKEN", value: "ghp_one" });
    const answer = await deliverSecret(
      {
        id: "edit-1",
        frame: {
          tenant: "acme/widget",
          key: "ANTHROPIC_API_KEY",
          action: "set",
          envelope: sealedForOther,
          by: OPERATOR,
        },
      },
      deps(),
    );
    expect(answer.outcome).toBe("refused");
  });

  test("a blank value, which is a clear wearing the wrong verb", async () => {
    const answer = await deliverSecret(
      await setRequest({ id: "edit-1", key: "GH_TOKEN", value: "" }),
      deps(),
    );
    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/A blank is not a secret/);
  });

  test("a tenant this deployment does not have", async () => {
    const answer = await deliverSecret(
      await setRequest({
        id: "edit-1",
        key: "GH_TOKEN",
        value: "ghp_one",
        tenant: "acme/nowhere",
      }),
      deps(),
    );
    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/does not match this deployment/);
  });

  test("a request with no envelope at all", async () => {
    const answer = await deliverSecret(
      {
        id: "edit-1",
        frame: { tenant: "acme/widget", key: "GH_TOKEN", action: "set", by: OPERATOR },
      },
      deps(),
    );
    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/no readable envelope/);
  });

  test("a set to a deployment with no box key on its volume", async () => {
    const answer = await deliverSecret(
      await setRequest({ id: "edit-1", key: "GH_TOKEN", value: "ghp_one" }),
      deps({ key: () => null }),
    );
    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/no box key on its volume/);
  });

  test("an action that is neither set nor clear", async () => {
    const answer = await deliverSecret(
      { id: "edit-1", frame: { tenant: "acme/widget", key: "GH_TOKEN", action: "delete" } },
      deps(),
    );
    expect(answer.outcome).toBe("refused");
    expect(detailOf(answer).detail).toMatch(/not a secret action/);
  });

  test("a request missing its tenant or its key", async () => {
    expect(
      (await deliverSecret({ id: "edit-1", frame: { key: "GH_TOKEN" } }, deps())).outcome,
    ).toBe("refused");
    expect(
      (await deliverSecret({ id: "edit-1", frame: { tenant: "acme/widget" } }, deps())).outcome,
    ).toBe("refused");
  });
});
