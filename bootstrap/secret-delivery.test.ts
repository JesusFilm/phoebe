// A secret over the API (map #690): the same gate the shell applies, a set and
// a clear that land, the blank refused, and the value absent from every line.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { readSecretStore, secretStorePath } from "../src/secret-store.ts";
import { deliverSecret } from "./secret-delivery.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-secret-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(stateDir: string, log: string[]) {
  return {
    configPath: "/deploy/phoebe.config.ts",
    dataBase: "/data",
    processEnv: {},
    resolveTarget: async (tenant: string) => {
      if (tenant !== "acme/widget") throw new Error(`No tenant \`${tenant}\` in this workspace.`);
      return {
        slug: "acme/widget",
        configPath: "/deploy/phoebe.config.ts",
        envPath: "/deploy/.env",
        stateDir,
        settable: ["GH_TOKEN", "ANTHROPIC_API_KEY"],
      };
    },
    log: (line: string) => log.push(line),
  };
}

describe("deliverSecret", () => {
  test("a set lands in the store with who asked, and the value is in no line", async () => {
    const stateDir = tmp();
    const log: string[] = [];
    const written: unknown[] = [];
    const answer = await deliverSecret(
      {
        id: "req_1",
        tenant: "acme/widget",
        key: "ANTHROPIC_API_KEY",
        value: "sk-secret-value",
        by: "device:lap",
      },
      { ...deps(stateDir, log), onWritten: (edit) => written.push(edit) },
    );
    expect(answer).toMatchObject({
      outcome: "written",
      tenant: "acme/widget",
      key: "ANTHROPIC_API_KEY",
      editId: "req_1",
    });
    expect(readSecretStore(stateDir)["ANTHROPIC_API_KEY"]).toBe("sk-secret-value");
    expect(written).toEqual([
      { tenant: "acme/widget", key: "ANTHROPIC_API_KEY", editId: "req_1", by: "device:lap" },
    ]);
    const everything = JSON.stringify(answer) + log.join("\n");
    expect(everything).not.toContain("sk-secret-value");
    expect(readFileSync(secretStorePath(stateDir), "utf8")).toContain("sk-secret-value");
  });

  test("a clear drops the key; clearing what is not there is written with a note", async () => {
    const stateDir = tmp();
    const log: string[] = [];
    await deliverSecret(
      { id: "r1", tenant: "acme/widget", key: "GH_TOKEN", value: "ghp_x", by: "me" },
      deps(stateDir, log),
    );
    const cleared = await deliverSecret(
      { id: "r2", tenant: "acme/widget", key: "GH_TOKEN", value: null, by: "me" },
      deps(stateDir, log),
    );
    expect(cleared).toMatchObject({
      outcome: "written",
      detail: expect.stringMatching(/Cleared GH_TOKEN/),
    });
    expect(readSecretStore(stateDir)["GH_TOKEN"]).toBeUndefined();
    const again = await deliverSecret(
      { id: "r3", tenant: "acme/widget", key: "GH_TOKEN", value: null, by: "me" },
      deps(stateDir, log),
    );
    expect(again).toMatchObject({
      outcome: "written",
      detail: expect.stringMatching(/nothing to clear/),
    });
  });

  test("an off-catalogue key, an unknown tenant, and a blank are each refused in the shell's words", async () => {
    const stateDir = tmp();
    const log: string[] = [];
    const off = await deliverSecret(
      { id: "r1", tenant: "acme/widget", key: "GH_APP_PRIVATE_KEY", value: "x", by: "me" },
      deps(stateDir, log),
    );
    expect(off.outcome).toBe("refused");
    const unknown = await deliverSecret(
      { id: "r1", tenant: "nobody/here", key: "GH_TOKEN", value: "x", by: "me" },
      deps(stateDir, log),
    );
    expect(unknown).toMatchObject({
      outcome: "refused",
      detail: expect.stringMatching(/No tenant/),
    });
    const blank = await deliverSecret(
      { id: "r1", tenant: "acme/widget", key: "GH_TOKEN", value: "", by: "me" },
      deps(stateDir, log),
    );
    expect(blank).toMatchObject({
      outcome: "refused",
      detail: expect.stringMatching(/blank is not a secret/),
    });
  });
});
