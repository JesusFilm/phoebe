// The report's config section (#535): who is asked, how often, what a failure
// looks like, and what stops the section growing with the fleet.

import { describe, expect, test } from "vite-plus/test";
import type { TenantEffectiveConfig } from "../src/contracts/effective-config.ts";
import {
  boundConfigRows,
  CONFIG_SECTION_BUDGET_BYTES,
  createConfigCollector,
  createRootConfigSource,
  unknownConfig,
} from "./config-report.ts";
import type { EngineCommandResult } from "./pipelines.ts";

const TARGET = {
  id: "/tenants/widget",
  configPath: "/tenants/widget/phoebe.config.ts",
  envPath: "/tenants/widget/.env",
  cwd: "/tenants/widget",
};

/** A `phoebe config --json` payload for one tenant, as the engine prints it. */
function payload(tenant: string, version = 1): string {
  return `${JSON.stringify({
    version,
    tenants: [
      {
        tenant,
        error: null,
        fields: { repoSlug: { value: tenant, source: "file", reader: "engine" } },
        env: { GH_TOKEN: { present: true, from: "tenantEnv" } },
        warnings: [],
      },
    ],
  })}\n`;
}

/** A collector over a scripted engine, with the calls it made recorded. */
function collectorOver(
  results: (args: readonly string[]) => EngineCommandResult,
  fingerprint: () => string | null = () => "fp",
) {
  const calls: (readonly string[])[] = [];
  const collector = createConfigCollector({
    entry: "/engine/src/cli.ts",
    fingerprint,
    run: (args) => {
      calls.push(args);
      return results(args);
    },
  });
  return { collector, calls };
}

describe("createConfigCollector", () => {
  test("asks the materialized engine for the tenant's own config, in the tenant's dir", () => {
    const seen: { args: readonly string[]; cwd?: string }[] = [];
    const collector = createConfigCollector({
      entry: "/engine/src/cli.ts",
      fingerprint: () => "fp",
      run: (args, opts) => {
        seen.push({ args, ...opts });
        return { status: 0, stdout: payload("acme/widget"), stderr: "" };
      },
    });

    const row = collector.read(TARGET);
    expect(seen[0]!.args).toEqual([
      "config",
      "--json",
      "--config",
      "/tenants/widget/phoebe.config.ts",
    ]);
    expect(seen[0]!.cwd).toBe("/tenants/widget");
    expect(row.tenant).toBe("acme/widget");
    expect(row.error).toBeNull();
    expect(row.fields).not.toBeNull();
  });

  test("the engine's shape version is the section's, not the bootstrapper's guess", () => {
    const { collector } = collectorOver(() => ({
      status: 0,
      stdout: payload("acme/widget", 7),
      stderr: "",
    }));
    collector.read(TARGET);
    expect(collector.version()).toBe(7);
  });

  test("a tenant is asked once per fingerprint — a steady config spawns nothing", () => {
    const { collector, calls } = collectorOver(() => ({
      status: 0,
      stdout: payload("acme/widget"),
      stderr: "",
    }));

    collector.read(TARGET);
    collector.read(TARGET);
    collector.read(TARGET);
    expect(calls).toHaveLength(1);
  });

  test("a moved config or `.env` is re-asked", () => {
    let stamp = "before";
    const { collector, calls } = collectorOver(
      () => ({ status: 0, stdout: payload("acme/widget"), stderr: "" }),
      () => stamp,
    );

    collector.read(TARGET);
    stamp = "after";
    collector.read(TARGET);
    expect(calls).toHaveLength(2);
  });

  test("an unreadable config is never cached — the answer is unknown, not absent", () => {
    const { collector, calls } = collectorOver(
      () => ({ status: 0, stdout: payload("acme/widget"), stderr: "" }),
      () => null,
    );

    collector.read(TARGET);
    collector.read(TARGET);
    expect(calls).toHaveLength(2);
  });

  test("an engine with no `config` verb is one tenant's error arm, never a throw", () => {
    const { collector } = collectorOver(() => ({
      status: 1,
      stdout: "",
      stderr: "Unknown command `config` for `phoebe`",
    }));

    const row = collector.read(TARGET);
    expect(row.fields).toBeNull();
    expect(row.env).toBeNull();
    expect(row.error).toContain("Unknown command");
  });

  test("`config` exiting 1 because the tenant's own config is broken still yields its row", () => {
    // `phoebe config` exits non-zero when every tenant errored, and for a
    // one-tenant question that is exactly the row worth reading.
    const { collector } = collectorOver(() => ({
      status: 1,
      stdout: `${JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant: "/tenants/widget/phoebe.config.ts",
            error: "repoSlug is required",
            fields: null,
            env: null,
            warnings: [],
          },
        ],
      })}\n`,
      stderr: "",
    }));

    const row = collector.read(TARGET);
    expect(row.error).toBe("repoSlug is required");
    expect(row.tenant).toBe("/tenants/widget/phoebe.config.ts");
  });

  test("output that is not the report is a fault reported as the tenant's, not parsed", () => {
    const { collector } = collectorOver(() => ({ status: 0, stdout: "hello\n", stderr: "" }));
    const row = collector.read(TARGET);
    expect(row.error).toContain("could not read the effective config");
  });

  test("a kind module printing on the way past does not hide the report", () => {
    const { collector } = collectorOver(() => ({
      status: 0,
      stdout: `[my-kind] loading\n${payload("acme/widget")}`,
      stderr: "",
    }));
    expect(collector.read(TARGET).tenant).toBe("acme/widget");
  });
});

describe("createRootConfigSource", () => {
  test("the fingerprint hashes the file's bytes, so identical text hashes alike", () => {
    const a = createRootConfigSource("/deployment/phoebe.config.ts", () => "export default {}");
    const b = createRootConfigSource("/other/phoebe.config.ts", () => "export default {}");
    expect(a().fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b().fingerprint).toBe(a().fingerprint);
  });

  test("an edit moves it", () => {
    let text = "export default { a: 1 }";
    let stat = "1:10";
    const source = createRootConfigSource(
      "/deployment/phoebe.config.ts",
      () => text,
      () => stat,
    );
    const before = source().fingerprint;
    text = "export default { a: 2 }";
    stat = "2:10";
    expect(source().fingerprint).not.toBe(before);
  });

  test("the file is re-hashed only when its stat moved — a publish costs one stat", () => {
    let reads = 0;
    const source = createRootConfigSource(
      "/deployment/phoebe.config.ts",
      () => {
        reads += 1;
        return "export default {}";
      },
      () => "1:10",
    );
    source();
    source();
    source();
    expect(reads).toBe(1);
  });

  test("a config that cannot be read has no fingerprint, which refuses every edit", () => {
    const source = createRootConfigSource(
      "/deployment/phoebe.config.ts",
      () => {
        throw new Error("ENOENT");
      },
      () => null,
    );
    expect(source()).toEqual({ path: "/deployment/phoebe.config.ts", fingerprint: null });
  });
});

/** A row of roughly the size a real tenant's tree costs. */
function bigRow(name: string, leaves = 200): TenantEffectiveConfig {
  const fields: Record<string, unknown> = {};
  for (let i = 0; i < leaves; i++) {
    fields[`setting${i}`] = {
      value: `value-${i}-${"x".repeat(20)}`,
      source: "file",
      via: "/tenants/widget/phoebe.config.ts",
      reader: "engine",
    };
  }
  return {
    tenant: name,
    error: null,
    fields: fields as TenantEffectiveConfig["fields"],
    env: {},
    warnings: [],
  };
}

describe("boundConfigRows", () => {
  test("every tenant of an ordinary workspace fits, and nothing is counted out", () => {
    const rows = ["a", "b", "c"].map((name) => bigRow(name));
    expect(boundConfigRows(rows)).toEqual({ tenants: rows, omitted: 0 });
  });

  test("a fleet past the budget stops filling and says how many it left out", () => {
    const rows = Array.from({ length: 400 }, (_, i) => bigRow(`tenant-${i}`));
    const bounded = boundConfigRows(rows);
    expect(bounded.tenants.length).toBeLessThan(400);
    expect(bounded.omitted).toBe(400 - bounded.tenants.length);
    expect(JSON.stringify(bounded.tenants, null, 2).length).toBeLessThanOrEqual(
      CONFIG_SECTION_BUDGET_BYTES,
    );
  });

  test("the section does not grow once the budget is full, however many tenants arrive", () => {
    const two = boundConfigRows(Array.from({ length: 400 }, (_, i) => bigRow(`tenant-${i}`)));
    const four = boundConfigRows(Array.from({ length: 800 }, (_, i) => bigRow(`tenant-${i}`)));
    expect(four.tenants.length).toBe(two.tenants.length);
    expect(four.omitted).toBe(800 - four.tenants.length);
  });

  test("the rows carried are a prefix of the order given, so the file does not churn", () => {
    const rows = Array.from({ length: 400 }, (_, i) => bigRow(`tenant-${i}`));
    const bounded = boundConfigRows(rows);
    expect(bounded.tenants).toEqual(rows.slice(0, bounded.tenants.length));
  });

  test("one tenant always reports, even a config larger than the whole budget", () => {
    const huge = bigRow("acme/widget", 40_000);
    const bounded = boundConfigRows([huge, bigRow("acme/gadget")]);
    expect(bounded.tenants).toEqual([huge]);
    expect(bounded.omitted).toBe(1);
  });
});

describe("unknownConfig", () => {
  test("it is the error arm #502 fixed — no fields, no env, the reason in `error`", () => {
    expect(unknownConfig("acme/widget", "held — no config")).toEqual({
      tenant: "acme/widget",
      error: "held — no config",
      fields: null,
      env: null,
      warnings: [],
    });
  });
});
