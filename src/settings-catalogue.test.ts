// The catalogue's own invariants, and the guard that keeps them true (#530).
//
// The interesting test here is the last one: it walks every shipped source file
// and fails on a `PHOEBE_*` name that is neither catalogued nor listed as a
// deployment fact. That is what makes the catalogue *the* registry rather than
// one more list beside the code — a new ad-hoc `process.env["PHOEBE_…"]` read
// cannot land without either an entry or a deliberate "this is not a setting".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { WORK_KIND_NAMES } from "./config-schema.ts";
import {
  assertNoEnvNameCollisions,
  catalogueEnvNames,
  DEPLOYMENT_FACTS,
  deploymentGlobalEnvNames,
  deriveEnvName,
  envNames,
  kindEnvNames,
  overlayEnvNames,
  readNumber,
  readSetting,
  SETTINGS,
  settingAt,
  settingsHelp,
  workKindEnvVar,
} from "./settings-catalogue.ts";

const repoRoot = join(import.meta.dirname, "..");

describe("deriveEnvName", () => {
  test("upper-snakes a camelCase path", () => {
    expect(deriveEnvName("repoSlug")).toBe("PHOEBE_REPO_SLUG");
    expect(deriveEnvName("prOptOutLabel")).toBe("PHOEBE_PR_OPT_OUT_LABEL");
    expect(deriveEnvName("runTimeoutMs")).toBe("PHOEBE_RUN_TIMEOUT_MS");
  });

  test("joins a dotted path with underscores", () => {
    expect(deriveEnvName("deployment.slotCap")).toBe("PHOEBE_DEPLOYMENT_SLOT_CAP");
    expect(deriveEnvName("deployment.reconcileIntervalMs")).toBe(
      "PHOEBE_DEPLOYMENT_RECONCILE_INTERVAL_MS",
    );
  });

  test("maps hyphens in a kind name to underscores", () => {
    expect(workKindEnvVar("stale-pr-nudger", "model")).toBe("PHOEBE_STALE_PR_NUDGER_MODEL");
    expect(workKindEnvVar("reviews", "runTimeoutMs")).toBe("PHOEBE_REVIEWS_RUN_TIMEOUT_MS");
  });
});

describe("the catalogue", () => {
  test("every entry has a config path and one env name", () => {
    for (const entry of SETTINGS) {
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.env).toMatch(/^PHOEBE_[A-Z0-9_]+$/);
    }
  });

  test("no two entries share an env name (#513 decision 3)", () => {
    const seen = new Map<string, string>();
    for (const entry of SETTINGS) {
      for (const name of envNames(entry)) {
        expect(seen.get(name), `${name} is claimed twice`).toBeUndefined();
        seen.set(name, entry.path);
      }
    }
  });

  test("the derived name is the convention every non-overridden entry follows", () => {
    // `PHOEBE_BASE` is the one entry whose name predates the convention and is
    // kept because an operator's `.env` holds it.
    const overridden = SETTINGS.filter((entry) => entry.env !== deriveEnvName(entry.path));
    expect(overridden.map((entry) => entry.env)).toEqual(["PHOEBE_BASE"]);
  });

  test("the renames are permanent aliases, not deprecations", () => {
    expect(envNames(settingAt("defaultProvider"))).toContain("PHOEBE_AGENT");
    expect(envNames(settingAt("deployment.slotCap"))).toContain("PHOEBE_MAX_CONCURRENT_AGENTS");
    expect(envNames(settingAt("deployment.slotFloorBudget"))).toContain("PHOEBE_SLOT_FLOOR_BUDGET");
    expect(envNames(settingAt("deployment.reconcileIntervalMs"))).toContain(
      "PHOEBE_RECONCILE_INTERVAL_MS",
    );
    expect(kindEnvNames(settingAt("defaultProvider"), "reviews")).toEqual([
      "PHOEBE_REVIEWS_PROVIDER",
      "PHOEBE_REVIEWS_AGENT",
    ]);
  });

  test("the global model and effort leaves have derived env names", () => {
    expect(settingAt("model").env).toBe("PHOEBE_MODEL");
    expect(settingAt("effort").env).toBe("PHOEBE_EFFORT");
  });

  test("named pipelines are file-only — nothing addresses one", () => {
    for (const entry of SETTINGS) {
      expect(entry.path).not.toMatch(/^pipelines\./);
    }
  });

  test("the three host knobs live on the deployment block", () => {
    const hostKnobs = SETTINGS.filter((entry) => entry.reader === "bootstrapper");
    expect(hostKnobs.map((entry) => entry.path)).toEqual([
      "deployment.slotCap",
      "deployment.slotFloorBudget",
      "deployment.reconcileIntervalMs",
    ]);
  });

  test("the engine-dir and data-dir names are facts, not settings", () => {
    const factNames = DEPLOYMENT_FACTS.map((fact) => fact.name);
    expect(factNames).toContain("PHOEBE_ENGINE_DIR");
    expect(factNames).toContain("PHOEBE_DATA_DIR");
    expect(catalogueEnvNames()).not.toContain("PHOEBE_ENGINE_DIR");
    expect(catalogueEnvNames()).not.toContain("PHOEBE_DATA_DIR");
  });

  test("a deployment-global name is policy, never tenant identity", () => {
    const global = deploymentGlobalEnvNames();
    expect(global).toContain("PHOEBE_DEFAULT_PROVIDER");
    expect(global).toContain("PHOEBE_AGENT");
    expect(global).toContain("PHOEBE_POLL_INTERVAL_MS");
    expect(global).toContain("PHOEBE_ISSUES_RUN_TIMEOUT_MS");
    // Tenant identity: one deployment-wide value would rewrite every tenant.
    expect(global).not.toContain("PHOEBE_REPO_SLUG");
    expect(global).not.toContain("PHOEBE_READY_LABEL");
    // A bootstrapper knob is read by boot itself and never handed to a child.
    expect(global).not.toContain("PHOEBE_DEPLOYMENT_SLOT_CAP");
  });

  test("an env-only path is never written onto a config field", () => {
    for (const entry of SETTINGS) {
      if (entry.envOnly !== true) continue;
      expect(overlayEnvNames(entry), `${entry.env} has no file field to write`).toEqual([]);
    }
  });

  test("the help text is generated from the entries", () => {
    const help = settingsHelp();
    for (const entry of SETTINGS) expect(help).toContain(entry.env);
    expect(help).toContain("PHOEBE_AGENT → PHOEBE_DEFAULT_PROVIDER");
  });
});

describe("reading a setting", () => {
  const provider = settingAt("defaultProvider");

  test("the derived name wins over its alias", () => {
    expect(
      readSetting({ PHOEBE_DEFAULT_PROVIDER: "codex", PHOEBE_AGENT: "claude" }, provider),
    ).toEqual({ via: "PHOEBE_DEFAULT_PROVIDER", value: "codex" });
  });

  test("the alias is heard when the derived name is unset", () => {
    expect(readSetting({ PHOEBE_AGENT: "claude" }, provider)).toEqual({
      via: "PHOEBE_AGENT",
      value: "claude",
    });
  });

  test("an empty value reads as unset", () => {
    expect(readSetting({ PHOEBE_DEFAULT_PROVIDER: "", PHOEBE_AGENT: "claude" }, provider)).toEqual({
      via: "PHOEBE_AGENT",
      value: "claude",
    });
  });

  test("a number that fails its test falls through to the next name", () => {
    const names = envNames(settingAt("maxUnproductiveRuns"));
    expect(
      readNumber({ PHOEBE_MAX_UNPRODUCTIVE_RUNS: "0", PHOEBE_MAX_UNIT_TIMEOUTS: "4" }, names, {
        integer: true,
        min: 1,
      }),
    ).toBe(4);
  });
});

describe("assertNoEnvNameCollisions", () => {
  test("the built-in kinds derive no colliding name", () => {
    expect(() => assertNoEnvNameCollisions()).not.toThrow();
  });

  test("a custom kind whose derived name collides is an error", () => {
    expect(() => assertNoEnvNameCollisions([...WORK_KIND_NAMES, "default"])).toThrow(
      /PHOEBE_DEFAULT_PROVIDER is claimed by both/,
    );
  });

  test("a custom kind with its own names is fine", () => {
    expect(() => assertNoEnvNameCollisions([...WORK_KIND_NAMES, "stale-pr-nudger"])).not.toThrow();
  });
});

// --- The guard: no PHOEBE_* read bypasses the catalogue ---------------------

/** Every shipped (non-test) source file under the given roots. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.(ts|mjs)$/.test(name) && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The string-literal contents of one source, comments skipped and `${…}`
 * interpolations dropped. Scanning literals rather than raw text is what keeps
 * the guard honest both ways: prose in a comment cannot trip it, and a name
 * hidden in a message or a list cannot slip past it.
 */
export function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      let value = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        // An interpolated expression is code, not text — `${PHOEBE_FOO}` names
        // a local constant and says nothing about the environment.
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < source.length && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            i++;
          }
          continue;
        }
        value += source[i];
        i++;
      }
      i++;
      literals.push(value);
      continue;
    }
    i++;
  }
  return literals;
}

describe("every PHOEBE_* name in the tree", () => {
  const known = new Set([...catalogueEnvNames(), ...DEPLOYMENT_FACTS.map((fact) => fact.name)]);
  const files = ["src", "bootstrap", "kinds"].flatMap((dir) => sourceFiles(join(repoRoot, dir)));

  test("scans a meaningful number of files", () => {
    // A broken walk that found nothing would pass the guard vacuously.
    expect(files.length).toBeGreaterThan(50);
  });

  test("is catalogued, or listed as a fact about the deployment", () => {
    const uncatalogued = new Map<string, string[]>();
    for (const file of files) {
      const relative = file.slice(repoRoot.length + 1);
      if (relative === join("src", "settings-catalogue.ts")) continue;
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
        for (const match of literal.matchAll(/PHOEBE_[A-Z0-9_]+/g)) {
          const name = match[0];
          if (known.has(name)) continue;
          uncatalogued.set(name, [...(uncatalogued.get(name) ?? []), relative]);
        }
      }
    }
    expect(
      Object.fromEntries(uncatalogued),
      "Add the setting to src/settings-catalogue.ts, or list it under DEPLOYMENT_FACTS " +
        "if it is a fact about where Phoebe runs rather than a knob an operator turns.",
    ).toEqual({});
  });
});
