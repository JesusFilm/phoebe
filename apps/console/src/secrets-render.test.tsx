// What the secrets tab puts on screen, and what leaves it when an operator sets
// a key (#550).
//
// Two halves, and the second is the one that matters. The markup half is static,
// like the other tab tests: presence, provenance, the reason a key cannot be set
// here, and — the assertion this whole feature exists for — that no value
// appears anywhere on the page.
//
// The sending half calls `sendSecret` directly with a recording client. The
// envelope it produces is opened with a real private key, so what the test
// proves is what the design claims: what the console sends is sealed, what the
// deployment opens is the value that was typed, and nothing in between carries
// it in the clear.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { openSecret, sealSecret } from "phoebe-agent/contracts";
import { DeploymentPage } from "./deployment-page.tsx";
import { rowFacts } from "./facts.ts";
import { secretsOf, sendSecret, stdinCommand, whyNotSettable } from "./secrets-facts.ts";
import {
  BOX_KEY,
  NOW,
  listing,
  recordingClient,
  report,
  row,
  secrets,
  stored,
  client as stubClient,
  tenantSecrets,
} from "./test-fixture.ts";

const FINGERPRINT = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "sk-ant-api03-not-a-real-key";

/** A tenant with one of each kind of key an operator meets. */
const TENANT = tenantSecrets({
  keys: [
    listing({
      key: "ANTHROPIC_API_KEY",
      present: true,
      source: "store",
      setAt: "2026-09-18T09:00:00.000Z",
      by: "ada@example.test",
      shadowed: true,
    }),
    listing({ key: "GH_TOKEN", present: true, source: "tenantEnv" }),
    listing({ key: "SENTRY_DSN", present: false, source: "missing" }),
    listing({
      key: "GH_APP_PRIVATE_KEY",
      present: true,
      source: "process",
      unsettable:
        "GH_APP_PRIVATE_KEY is a deployment-scope credential: it is the App's private key " +
        "material. Edit the deployment's env-file and recreate the container.",
    }),
  ],
});

const FACTS = rowFacts(row(), stored(report({ secrets: secrets({ tenants: [TENANT] }) })));

const markup = renderToStaticMarkup(
  <DeploymentPage facts={FACTS} tab="secrets" now={NOW} client={stubClient()} />,
);

describe("what the tab shows", () => {
  test("the tab is linked from the deployment page, like the other three", () => {
    expect(markup).toContain(`href="#/d/${FINGERPRINT}/secrets">secrets<`);
  });

  test("one row per key, with where its value comes from", () => {
    expect(markup).toContain("ANTHROPIC_API_KEY");
    expect(markup).toContain("the secret store");
    expect(markup).toContain("the tenant&#x27;s .env");
    expect(markup).toContain("the container&#x27;s environment");
    expect(markup).toContain("nowhere — nothing sets it");
  });

  test("a key the store shadows says so — a .env edit there changes nothing", () => {
    expect(markup).toContain("shadows the .env");
  });

  test("who set a key, and when, from the ledger", () => {
    expect(markup).toContain("2026-09-18T09:00:00.000Z by ada@example.test");
  });

  test("a deployment-scope key is shown, not settable, and says why", () => {
    // Hiding it would leave an operator hunting for a key they can see is in
    // use; a disabled button with no sentence would leave them guessing.
    expect(markup).toContain("GH_APP_PRIVATE_KEY");
    expect(markup).toContain("not settable here");
    expect(markup).toContain("deployment-scope credential");
  });

  test("and no value, of any length, is anywhere on the page", () => {
    // The assertion the whole feature exists for. Nothing in the section the
    // page renders carries a value, so there is nothing here to redact.
    expect(markup).not.toContain(SECRET);
    expect(markup).not.toContain("sk-");
    expect(markup).not.toContain("ghp_");
    // No last-four, no hash, no length: the words that would introduce one.
    expect(markup).not.toMatch(/last four|ending in|sha256|characters long/i);
  });
});

describe("a deployment with nothing to say about its secrets", () => {
  test("says which kind of nothing it is", () => {
    const quiet = rowFacts(row(), stored(report()));
    const page = renderToStaticMarkup(
      <DeploymentPage facts={quiet} tab="secrets" now={NOW} client={stubClient()} />,
    );
    expect(page).toContain("carries no secrets section");
    expect(secretsOf(quiet)).toBeNull();
  });

  test("a deployment that has never connected gets the page the other tabs get", () => {
    const unseen = rowFacts(row({ state: "unseen", lastSeen: null }), null);
    const page = renderToStaticMarkup(
      <DeploymentPage facts={unseen} tab="secrets" now={NOW} client={stubClient()} />,
    );
    expect(page).toContain("has never connected");
  });
});

describe("whether this console may set a key", () => {
  test("a connected deployment with a box key may, for a settable key", () => {
    expect(whyNotSettable(listing({ key: "GH_TOKEN" }), TENANT, row())).toBeNull();
  });

  test("the deployment's own refusal wins, and is carried verbatim", () => {
    const refusal = whyNotSettable(
      listing({ key: "GH_APP_ID", unsettable: "GH_APP_ID is a deployment-scope credential" }),
      TENANT,
      row(),
    );
    expect(refusal).toBe("GH_APP_ID is a deployment-scope credential");
  });

  test("a dark deployment cannot be reached, and the page says that rather than trying", () => {
    expect(whyNotSettable(listing(), TENANT, row({ state: "dark" }))).toMatch(/nothing is queued/);
  });

  test("a deployment with no box key has nothing to encrypt to", () => {
    expect(whyNotSettable(listing(), TENANT, row({ boxKey: null }))).toMatch(/no box key/);
  });

  test("a tenant whose config will not load has no known settable set", () => {
    const broken = tenantSecrets({ error: "unknown provider", keys: [] });
    expect(whyNotSettable(listing(), broken, row())).toMatch(/unknown provider/);
  });
});

describe("sending one", () => {
  /** A real key pair, so the envelope the page produces is opened for real. */
  async function boxKeyPair(): Promise<{ boxKey: string; boxPrivateKey: Uint8Array<ArrayBuffer> }> {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    return {
      boxKey: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      boxPrivateKey: pkcs8,
    };
  }

  test("what leaves the page is an envelope the deployment opens, and nothing else", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const { client, sent } = recordingClient({ outcome: "written" });

    const result = await sendSecret({
      client,
      row: row({ boxKey }),
      tenant: "JesusFilm/youtube-studio",
      key: "ANTHROPIC_API_KEY",
      value: SECRET,
      editId: "edit-1",
    });

    expect(result.outcome).toBe("written");
    const request = sent[0]!;
    expect(JSON.stringify(request)).not.toContain(SECRET);
    await expect(
      openSecret({
        boxPrivateKey,
        aad: {
          keyFingerprint: FINGERPRINT,
          tenant: "JesusFilm/youtube-studio",
          key: "ANTHROPIC_API_KEY",
          editId: "edit-1",
        },
        envelope: JSON.parse(request.envelope!) as never,
      }),
    ).resolves.toBe(SECRET);
  });

  test("the envelope is bound to the edit, so the same one cannot be re-sent", async () => {
    // The console picks the id and seals against it; the deployment rebuilds the
    // AAD from the request it received. Move the id and the two disagree.
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({
      boxKey,
      aad: {
        keyFingerprint: FINGERPRINT,
        tenant: "JesusFilm/youtube-studio",
        key: "ANTHROPIC_API_KEY",
        editId: "edit-1",
      },
      plaintext: SECRET,
    });

    await expect(
      openSecret({
        boxPrivateKey,
        aad: {
          keyFingerprint: FINGERPRINT,
          tenant: "JesusFilm/youtube-studio",
          key: "ANTHROPIC_API_KEY",
          editId: "edit-2",
        },
        envelope,
      }),
    ).rejects.toThrow(/not sealed for this deployment/);
  });

  test("a clear carries no envelope — there is no value to seal", async () => {
    const { client, sent } = recordingClient({ outcome: "written" });

    await sendSecret({
      client,
      row: row({ boxKey: BOX_KEY }),
      tenant: "JesusFilm/youtube-studio",
      key: "ANTHROPIC_API_KEY",
      value: null,
      editId: "edit-2",
    });

    expect(sent[0]).toMatchObject({ action: "clear", key: "ANTHROPIC_API_KEY" });
    expect(sent[0]?.envelope).toBeUndefined();
  });

  test("the request never carries `by` — the relay stamps that itself", () => {
    const { client, sent } = recordingClient({ outcome: "written" });
    return sendSecret({
      client,
      row: row({ boxKey: BOX_KEY }),
      tenant: "JesusFilm/youtube-studio",
      key: "GH_TOKEN",
      value: "ghp_one",
      editId: "edit-3",
    }).then(() => {
      expect(Object.keys(sent[0]!)).not.toContain("by");
    });
  });
});

describe("a receipt", () => {
  test("`written` is the end of the walk, and says what happens next", async () => {
    const { client } = recordingClient({
      outcome: "written",
      detail: {
        tenant: "JesusFilm/youtube-studio",
        key: "GH_TOKEN",
        editId: "edit-1",
        detail: "Wrote GH_TOKEN. The pipeline that reads it relaunches on the next poll.",
      },
    });

    const result = await sendSecret({
      client,
      row: row({ boxKey: BOX_KEY }),
      tenant: "JesusFilm/youtube-studio",
      key: "GH_TOKEN",
      value: "ghp_one",
      editId: "edit-1",
    });

    expect(result.detail).toMatch(/relaunches/);
    expect(result.undelivered).toBe(false);
  });

  test("`refused` carries the deployment's own sentence, not the page's guess", async () => {
    const { client } = recordingClient({
      outcome: "refused",
      detail: {
        tenant: "JesusFilm/youtube-studio",
        key: "SOMETHING_ELSE",
        detail: "SOMETHING_ELSE is not a key this tenant reads.",
      },
    });

    const result = await sendSecret({
      client,
      row: row({ boxKey: BOX_KEY }),
      tenant: "JesusFilm/youtube-studio",
      key: "SOMETHING_ELSE",
      value: "whatever",
      editId: "edit-1",
    });

    expect(result.outcome).toBe("refused");
    expect(result.detail).toBe("SOMETHING_ELSE is not a key this tenant reads.");
  });

  test("`undelivered` ends the walk and hands over the command for the host", async () => {
    const { client } = recordingClient({ outcome: "undelivered" });

    const result = await sendSecret({
      client,
      row: row({ boxKey: BOX_KEY }),
      tenant: "JesusFilm/youtube-studio",
      key: "GH_TOKEN",
      value: "ghp_one",
      editId: "edit-1",
    });

    expect(result.undelivered).toBe(true);
    expect(result.detail).toMatch(/Nothing was queued/);
  });
});

describe("the command for the host", () => {
  test("takes the value on stdin, never as an argument", () => {
    // An argument lands in shell history and in `/proc/<pid>/cmdline`, which a
    // co-tenant sharing the container's uid can read. That is the one place
    // this design would leak where a `.env` does not.
    const command = stdinCommand({
      key: "ANTHROPIC_API_KEY",
      tenant: "JesusFilm/youtube-studio",
      action: "set",
    });
    expect(command).toBe(
      'printf %s "$ANTHROPIC_API_KEY" | docker compose exec -T phoebe ' +
        "phoebe secret set ANTHROPIC_API_KEY --tenant JesusFilm/youtube-studio",
    );
  });

  test("a clear has no value, so it has no pipe", () => {
    expect(
      stdinCommand({ key: "GH_TOKEN", tenant: "JesusFilm/youtube-studio", action: "clear" }),
    ).toBe(
      "docker compose exec phoebe phoebe secret clear GH_TOKEN --tenant JesusFilm/youtube-studio",
    );
  });
});
