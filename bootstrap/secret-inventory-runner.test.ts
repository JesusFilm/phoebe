// When the inventory is retaken, and what happens when two asks land at once.

import { describe, expect, test } from "vite-plus/test";
import type { SecretsSection } from "../src/contracts/secrets.ts";
import type { InventoryTenant } from "../src/secret-inventory.ts";
import { createSecretInventory } from "./secret-inventory-runner.ts";

const tenant = (slug: string): InventoryTenant => ({
  configPath: `/srv/${slug}/phoebe.config.ts`,
  path: `/srv/${slug}`,
  slug,
});

type Harness = {
  sections: Omit<SecretsSection, "updatedAt">[];
  /** One entry per scan, holding the tenants it was asked about. */
  scans: string[][];
  /** Let the scan that is waiting finish. */
  settle: () => Promise<void>;
  runner: ReturnType<typeof createSecretInventory>;
  warnings: string[];
};

/** A runner whose scans do not finish until the test says so. */
function harness(opts: { fail?: boolean } = {}): Harness {
  const sections: Omit<SecretsSection, "updatedAt">[] = [];
  const scans: string[][] = [];
  const warnings: string[] = [];
  const waiting: (() => void)[] = [];

  const runner = createSecretInventory({
    state: { noteSecrets: (section) => sections.push(section) },
    dataBase: "/data",
    processEnv: {},
    warn: (message) => warnings.push(message),
    take: async (tenants) => {
      scans.push(tenants.map((entry) => entry.slug ?? entry.path));
      await new Promise<void>((resolve) => waiting.push(resolve));
      if (opts.fail === true) throw new Error("the volume went away");
      return {
        tenants: tenants.map((entry) => ({
          tenant: entry.slug!,
          path: entry.path,
          error: null,
          keys: [],
        })),
      };
    },
  });

  return {
    sections,
    scans,
    warnings,
    runner,
    settle: async () => {
      waiting.shift()?.();
      // Two turns: one for the scan's own await, one for the publish after it.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("when an inventory is taken", () => {
  test("a first tenant set is scanned and published", async () => {
    const h = harness();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget")]);
    await h.settle();

    expect(h.scans).toEqual([["acme/widget"]]);
    expect(h.sections).toHaveLength(1);
  });

  test("the same tenant set again is not scanned again", async () => {
    // The poll calls this every few seconds. Taking an inventory loads every
    // tenant's work kinds, so "nothing moved" has to mean "do nothing".
    const h = harness();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget")]);
    await h.settle();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget")]);
    await h.settle();

    expect(h.scans).toHaveLength(1);
  });

  test("a tenant appearing is a new set", async () => {
    const h = harness();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget")]);
    await h.settle();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget"), tenant("acme/gadget")]);
    await h.settle();

    expect(h.scans).toHaveLength(2);
    expect(h.scans[1]).toEqual(["acme/widget", "acme/gadget"]);
  });

  test("a tenant becoming held is a new set too", async () => {
    // Its keys just became unknown, which is a change to the answer even though
    // the tenant list is the same length.
    const h = harness();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget")]);
    await h.settle();
    h.runner.refreshIfTenantsMoved([{ ...tenant("acme/widget"), heldReason: "no remote" }]);
    await h.settle();

    expect(h.scans).toHaveLength(2);
  });

  test("an edit retakes the last set without being told what it was", async () => {
    const h = harness();
    h.runner.refreshIfTenantsMoved([tenant("acme/widget")]);
    await h.settle();

    void h.runner.refreshLast();
    await h.settle();

    expect(h.scans).toEqual([["acme/widget"], ["acme/widget"]]);
  });
});

describe("two asks at once", () => {
  test("the second waits, and then runs — the last answer is the one published", async () => {
    // Two scans in flight would race to publish, and the loser could be the
    // older answer. So one runs at a time and the queued ask follows it.
    const h = harness();
    void h.runner.refresh([tenant("acme/widget")]);
    void h.runner.refresh([tenant("acme/gadget")]);

    expect(h.scans).toEqual([["acme/widget"]]);

    await h.settle();
    expect(h.scans).toEqual([["acme/widget"], ["acme/gadget"]]);
  });

  test("a scan that fails is a warning, and the section is left alone", async () => {
    const h = harness({ fail: true });
    void h.runner.refresh([tenant("acme/widget")]);
    await h.settle();

    expect(h.sections).toEqual([]);
    expect(h.warnings[0]).toMatch(/could not take the secrets inventory/);
  });
});
