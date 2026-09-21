import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { planRelayInitOutputs, relayInitNextSteps, runRelayInit } from "./init.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-relay-init-"));
}

describe("runRelayInit", () => {
  test("writes the whole scaffold under relay/", () => {
    const dir = tempDir();

    const report = runRelayInit({ targetDir: dir });

    expect(report.created).toEqual([
      "relay/Dockerfile",
      "relay/compose.yml",
      "relay/.env.example",
      "relay/.gitignore",
    ]);
    expect(report.skipped).toEqual([]);
    for (const relPath of report.created) {
      expect(readFileSync(join(dir, relPath), "utf8").length).toBeGreaterThan(0);
    }
  });

  test("renders every placeholder — a scaffolded file is not a template", () => {
    const dir = tempDir();

    runRelayInit({ targetDir: dir, params: { cliBin: "phoebe-agent", cliVersion: "1.2.3" } });

    const dockerfile = readFileSync(join(dir, "relay/Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG PHOEBE_AGENT_VERSION=1.2.3");
    expect(dockerfile).toContain("npm install -g phoebe-agent@${PHOEBE_AGENT_VERSION}");
    expect(dockerfile).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("pins the version of the CLI that scaffolded it (#506 §1)", () => {
    // The relay's version is the bootstrapper's, so whichever CLI writes this
    // file is the one the image should install. A hard-coded pin in the
    // template would scaffold yesterday's relay forever.
    const dir = tempDir();
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    runRelayInit({ targetDir: dir });

    expect(readFileSync(join(dir, "relay/Dockerfile"), "utf8")).toContain(
      `ARG PHOEBE_AGENT_VERSION=${manifest.version}`,
    );
  });

  test("a re-run keeps an edited file and says it kept it", () => {
    const dir = tempDir();
    runRelayInit({ targetDir: dir });
    const edited = "# my own base image\nFROM node:24-alpine\n";
    writeFileSync(join(dir, "relay/Dockerfile"), edited);

    const report = runRelayInit({ targetDir: dir });

    expect(readFileSync(join(dir, "relay/Dockerfile"), "utf8")).toBe(edited);
    expect(report.created).toEqual([]);
    expect(report.skipped).toContain("relay/Dockerfile");
    expect(report.skipped).toContain("relay/compose.yml");
  });

  test("a partial scaffold fills the gaps and leaves the rest", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "relay"), { recursive: true });
    writeFileSync(join(dir, "relay/compose.yml"), "name: mine\n");

    const report = runRelayInit({ targetDir: dir });

    expect(report.created).toContain("relay/Dockerfile");
    expect(report.skipped).toEqual(["relay/compose.yml"]);
    expect(readFileSync(join(dir, "relay/compose.yml"), "utf8")).toBe("name: mine\n");
  });

  test("keeps the .env holding GOOGLE_CLIENT_SECRET out of git", () => {
    const dir = tempDir();

    runRelayInit({ targetDir: dir });

    expect(readFileSync(join(dir, "relay/.gitignore"), "utf8")).toContain(".env");
  });

  test("appends to an existing .gitignore rather than replacing it", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "relay"), { recursive: true });
    writeFileSync(join(dir, "relay/.gitignore"), "certs/\n");

    const report = runRelayInit({ targetDir: dir });

    const gitignore = readFileSync(join(dir, "relay/.gitignore"), "utf8");
    expect(gitignore).toContain("certs/");
    expect(gitignore).toContain(".env");
    expect(report.updated).toEqual(["relay/.gitignore"]);
  });

  test("creates the target directory when it does not exist yet", () => {
    const dir = join(tempDir(), "nested", "deployment");

    const report = runRelayInit({ targetDir: dir });

    expect(report.created).toContain("relay/compose.yml");
  });
});

describe("planRelayInitOutputs", () => {
  test("names the three files #506 §1 promises, plus the gitignore", () => {
    expect(planRelayInitOutputs().map((output) => output.destRelPath)).toEqual([
      "relay/Dockerfile",
      "relay/compose.yml",
      "relay/.env.example",
      "relay/.gitignore",
    ]);
  });
});

describe("relayInitNextSteps", () => {
  test("ends on the command that starts it, after DNS and the Google client", () => {
    const steps = relayInitNextSteps("/srv/phoebe");

    expect(steps).toContain("/srv/phoebe/relay");
    expect(steps).toContain(".env");
    expect(steps).toContain("RELAY_HOST");
    expect(steps.indexOf("docker compose up")).toBeGreaterThan(steps.indexOf("RELAY_HOST"));
  });
});
