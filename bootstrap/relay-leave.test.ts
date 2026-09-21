// `phoebe relay leave`: the key goes, and the operator is told what is left.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { generateDeploymentKey, relayKeyPath, saveDeploymentKey } from "./relay-key.ts";
import { relayLeave } from "./relay-leave.ts";

describe("relayLeave", () => {
  let volume: string;

  beforeEach(() => {
    volume = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
  });

  afterEach(() => {
    rmSync(volume, { recursive: true, force: true });
  });

  test("deletes the deployment key", () => {
    saveDeploymentKey(relayKeyPath(volume), generateDeploymentKey());

    const left = relayLeave({ dataBase: volume, log: () => {} });

    expect(left).toEqual({ keyPath: relayKeyPath(volume), deleted: true });
    expect(existsSync(relayKeyPath(volume))).toBe(false);
  });

  test("and says what does not happen on its own", () => {
    saveDeploymentKey(relayKeyPath(volume), generateDeploymentKey());
    const lines: string[] = [];

    relayLeave({ dataBase: volume, log: (message) => lines.push(message) });

    const said = lines.join("\n");
    expect(said).toContain("`relay` block");
    expect(said).toContain("forget");
  });

  test("leaving twice is leaving once", () => {
    saveDeploymentKey(relayKeyPath(volume), generateDeploymentKey());
    relayLeave({ dataBase: volume, log: () => {} });

    expect(relayLeave({ dataBase: volume, log: () => {} }).deleted).toBe(false);
  });

  test("an unpaired deployment is told so rather than given an error", () => {
    const lines: string[] = [];

    const left = relayLeave({ dataBase: volume, log: (message) => lines.push(message) });

    expect(left.deleted).toBe(false);
    expect(lines.join("\n")).toContain("not paired");
  });

  test("it touches nothing else on the volume", () => {
    saveDeploymentKey(relayKeyPath(volume), generateDeploymentKey());
    const neighbour = join(dirname(relayKeyPath(volume)), "deployment.json");
    mkdirSync(dirname(neighbour), { recursive: true });
    writeFileSync(neighbour, "{}\n");

    relayLeave({ dataBase: volume, log: () => {} });

    expect(existsSync(neighbour)).toBe(true);
  });
});
