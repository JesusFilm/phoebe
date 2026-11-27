// Spend limits (#990): the `spend` block's validation, its env overlay, and the
// evaluation the bootstrapper runs. The report's own wiring is
// bootstrap/deployment-state.test.ts; this file is pure functions.

import { describe, expect, test } from "vite-plus/test";
import type { SpendField } from "./contracts/spend.ts";
import type { AgentRunRecord, UnitRecord } from "./contracts/unit-record.ts";
import { resolveConfig, validateUserConfig, type PhoebeUserConfig } from "./config-schema.ts";
import { applyEnvOverlay } from "./load-config.ts";
import {
  bindingHold,
  createSpendClock,
  describeSpendHold,
  estimateRelease,
  evaluateSpend,
  readSpendField,
  spendTotals,
  validateSpendField,
} from "./spend.ts";
import { summarizeHistory } from "./unit-history.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-05-05T00:00:00.000Z");

function user(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    startedAt: new Date(NOW).toISOString(),
    durationMs: 1000,
    exitCode: 0,
    promptSha: "sha",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    costUsd: null,
    turns: 1,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: true,
    toolCalls: {},
    costBasis: null,
    ...overrides,
  };
}

function unitAt(startedAt: number, runs: AgentRunRecord[]): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issue", id: String(startedAt) },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: new Date(startedAt).toISOString(),
    settledAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    runBudgetMs: null,
    provider: "claude",
    model: null,
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: runs,
  };
}

describe("the spend block in config", () => {
  test("is accepted on the tenant and on a pipeline", () => {
    expect(() =>
      validateUserConfig(
        user({
          spend: { warn: { usd24h: 10, tokens7d: 1e6 }, ceiling: { usd24h: 20 } },
          pipelines: { work: { spend: { ceiling: { tokens24h: 5e5, usd7d: 100 } } } },
        }),
      ),
    ).not.toThrow();
  });

  test("is carried onto the resolved config, and an empty one is no limits", () => {
    const config = resolveConfig(
      user({
        spend: { ceiling: { usd24h: 20 } },
        pipelines: { work: { spend: { warn: {} } }, triage: { spend: { warn: { usd7d: 3 } } } },
      }),
    );
    expect(config.spend).toEqual({ ceiling: { usd24h: 20 } });
    expect(config.pipelines["work"]!.spend).toBeUndefined();
    expect(config.pipelines["triage"]!.spend).toEqual({ warn: { usd7d: 3 } });
    expect(resolveConfig(user()).spend).toBeUndefined();
  });

  test("a ceiling below its warning limit is an error naming both", () => {
    expect(() =>
      validateUserConfig(user({ spend: { warn: { usd24h: 10 }, ceiling: { usd24h: 5 } } })),
    ).toThrow(/`spend\.ceiling\.usd24h` \(5\) is below .*`spend\.warn\.usd24h` \(10\)/);
    expect(() =>
      validateUserConfig(
        user({
          pipelines: { work: { spend: { warn: { tokens7d: 10 }, ceiling: { tokens7d: 9 } } } },
        }),
      ),
    ).toThrow(
      /`pipelines\.work\.spend\.ceiling\.tokens7d` \(9\) is below .*`pipelines\.work\.spend\.warn\.tokens7d`/,
    );
  });

  test("a ceiling at its warning limit, or with no matching warning, is fine", () => {
    expect(() =>
      validateSpendField(
        { warn: { usd24h: 5, usd7d: 50 }, ceiling: { usd24h: 5, tokens24h: 1 } },
        "spend",
      ),
    ).not.toThrow();
  });

  test.each([
    [{ warn: { usd24h: 0 } }, /spend\.warn\.usd24h` must be a positive number/],
    [{ warn: { usd24h: -1 } }, /must be a positive number/],
    [{ ceiling: { usd24h: "5" } }, /must be a positive number/],
    [{ ceiling: { usd30d: 5 } }, /unknown limit "usd30d"/],
    [{ cap: {} }, /unknown field "cap"/],
    [{ warn: 5 }, /`spend\.warn` must be an object/],
    [[], /`spend` must be an object/],
  ])("rejects %j", (spend, message) => {
    expect(() => validateSpendField(spend, "spend")).toThrow(message);
  });

  test("belongs on a tenant, never a workspace root", () => {
    expect(() =>
      validateUserConfig(user({ workspace: {}, spend: { ceiling: { usd24h: 1 } } })),
    ).toThrow(/`spend` on a workspace root/);
  });

  test("its tenant limits answer to their catalogued env names, which beat the file", () => {
    const overlaid = applyEnvOverlay(
      user({ spend: { warn: { usd24h: 4 }, ceiling: { usd24h: 8, usd7d: 40 } } }),
      { PHOEBE_SPEND_CEILING_USD24H: "12", PHOEBE_SPEND_WARN_TOKENS7D: "1000" },
    );
    expect(resolveConfig(overlaid).spend).toEqual({
      warn: { usd24h: 4, tokens7d: 1000 },
      ceiling: { usd24h: 12, usd7d: 40 },
    });
  });

  test("an env limit that is not a positive number throws naming the variable", () => {
    expect(() => applyEnvOverlay(user(), { PHOEBE_SPEND_CEILING_USD7D: "lots" })).toThrow(
      /PHOEBE_SPEND_CEILING_USD7D must be a positive number/,
    );
  });

  test("an env ceiling below the file's warning limit is the same config error", () => {
    const overlaid = applyEnvOverlay(user({ spend: { warn: { usd24h: 10 } } }), {
      PHOEBE_SPEND_CEILING_USD24H: "5",
    });
    expect(() => resolveConfig(overlaid)).toThrow(/is below/);
  });
});

describe("reading the block back off the enumeration", () => {
  test("keeps the positive limits and drops anything else", () => {
    expect(
      readSpendField({ warn: { usd24h: 3, usd7d: -1, junk: 4 }, ceiling: "no", extra: {} }),
    ).toEqual({ warn: { usd24h: 3 } });
    expect(readSpendField({ warn: {} })).toBeUndefined();
    expect(readSpendField(null)).toBeUndefined();
  });
});

describe("the measures", () => {
  test("usd is API spend only: a subscription estimate never counts", () => {
    const summary = summarizeHistory(
      [
        unitAt(NOW - HOUR, [run({ costUsd: 1.5, costBasis: "api" })]),
        unitAt(NOW - HOUR, [run({ costUsd: 900, costBasis: "subscription-estimate" })]),
      ],
      NOW,
    );
    expect(spendTotals(summary).usd24h).toBe(1.5);
  });

  test("tokens are input plus output, cache left out", () => {
    const summary = summarizeHistory(
      [
        unitAt(NOW - 2 * 24 * HOUR, [
          run({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 999, cacheWriteTokens: 999 }),
        ]),
        unitAt(NOW - HOUR, [run({ inputTokens: 1, outputTokens: 2 })]),
      ],
      NOW,
    );
    expect(spendTotals(summary)).toEqual({ usd24h: 0, usd7d: 0, tokens24h: 3, tokens7d: 18 });
  });
});

describe("evaluating a scope's limits", () => {
  const limits: SpendField = { warn: { usd24h: 2 }, ceiling: { usd24h: 4, tokens7d: 100 } };

  function evaluate(records: UnitRecord[], spend: SpendField | undefined = limits) {
    return evaluateSpend({
      scope: "tenant",
      clockKey: "t",
      limits: spend,
      totals: spendTotals(summarizeHistory(records, NOW)),
      records,
      asOf: NOW,
      clock: createSpendClock(),
    });
  }

  test("under every limit, nothing is reached", () => {
    expect(evaluate([unitAt(NOW - HOUR, [run({ costUsd: 1, costBasis: "api" })])])).toEqual({
      holds: [],
      warnings: [],
    });
  });

  test("a limit is reached at exactly its value", () => {
    const result = evaluate([unitAt(NOW - HOUR, [run({ costUsd: 4, costBasis: "api" })])]);
    expect(result.warnings).toHaveLength(1);
    expect(result.holds.map((hold) => hold.limit)).toEqual([4]);
  });

  test("a subscription estimate trips no usd ceiling, however large", () => {
    const result = evaluate([
      unitAt(NOW - HOUR, [run({ costUsd: 1e6, costBasis: "subscription-estimate" })]),
    ]);
    expect(result).toEqual({ holds: [], warnings: [] });
  });

  test("no block, no limits", () => {
    const records = [unitAt(NOW - HOUR, [run({ costUsd: 1e6, costBasis: "api" })])];
    const result = evaluateSpend({
      scope: "pipeline",
      clockKey: "p",
      limits: undefined,
      totals: spendTotals(summarizeHistory(records, NOW)),
      records,
      asOf: NOW,
      clock: createSpendClock(),
    });
    expect(result).toEqual({ holds: [], warnings: [] });
  });

  test("the hold that binds is the one that lets go last", () => {
    const result = evaluate([
      unitAt(NOW - 6 * 24 * HOUR, [run({ inputTokens: 200 })]),
      unitAt(NOW - HOUR, [run({ costUsd: 5, costBasis: "api" })]),
    ]);
    expect(result.holds.map((hold) => hold.window)).toEqual(["24h", "7d"]);
    // The usd hold lets go in 23 hours; the token one only in 24, so it binds.
    expect(result.holds.map((hold) => hold.releaseAt)).toEqual([
      "2026-05-05T23:00:00.000Z",
      "2026-05-06T00:00:00.000Z",
    ]);
    expect(bindingHold(result.holds)?.measure).toBe("tokens");
  });

  test("since stays put across evaluations, and starts again once the hold has let go", () => {
    const clock = createSpendClock();
    const records = [unitAt(NOW - HOUR, [run({ costUsd: 5, costBasis: "api" })])];
    const at = (asOf: number, spend: UnitRecord[]) =>
      evaluateSpend({
        scope: "pipeline",
        clockKey: "p",
        limits,
        totals: spendTotals(summarizeHistory(spend, asOf)),
        records: spend,
        asOf,
        clock,
      });
    expect(at(NOW, records).holds[0]?.since).toBe("2026-05-05T00:00:00.000Z");
    clock.sweep();
    expect(at(NOW + HOUR, records).holds[0]?.since).toBe("2026-05-05T00:00:00.000Z");
    clock.sweep();
    expect(at(NOW + 2 * HOUR, []).holds).toEqual([]);
    clock.sweep();
    expect(at(NOW + 3 * HOUR, records).holds[0]?.since).toBe("2026-05-05T03:00:00.000Z");
  });
});

describe("estimating when a hold lets go", () => {
  test("is when enough of the oldest spend has aged out to fall under the limit", () => {
    const records = [
      unitAt(NOW - 20 * HOUR, [run({ costUsd: 1, costBasis: "api" })]),
      unitAt(NOW - 10 * HOUR, [run({ costUsd: 3, costBasis: "api" })]),
      unitAt(NOW - 1 * HOUR, [run({ costUsd: 2, costBasis: "api" })]),
    ];
    // $6 against $3: the $1 unit leaving takes it to $5, the $3 one to $2.
    expect(
      new Date(
        estimateRelease({
          records,
          measure: "usd",
          windowMs: 24 * HOUR,
          limit: 3,
          total: 6,
          asOf: NOW,
        }),
      ).toISOString(),
    ).toBe("2026-05-05T14:00:00.000Z");
  });

  test("a subscription estimate leaving the window frees nothing", () => {
    const records = [
      unitAt(NOW - 20 * HOUR, [run({ costUsd: 50, costBasis: "subscription-estimate" })]),
      unitAt(NOW - 10 * HOUR, [run({ costUsd: 5, costBasis: "api" })]),
    ];
    expect(
      new Date(
        estimateRelease({
          records,
          measure: "usd",
          windowMs: 24 * HOUR,
          limit: 5,
          total: 5,
          asOf: NOW,
        }),
      ).toISOString(),
    ).toBe("2026-05-05T14:00:00.000Z");
  });
});

describe("describing a hold", () => {
  test("names the ceiling at its config path, what was spent, and when it lets go", () => {
    const line = describeSpendHold(
      {
        scope: "pipeline",
        measure: "usd",
        window: "24h",
        limit: 5,
        spent: 6.5,
        since: "2026-05-05T00:00:00.000Z",
        releaseAt: "2026-05-05T21:00:00.000Z",
      },
      "observer",
    );
    expect(line).toContain("`pipelines.observer.spend.ceiling.usd24h`");
    expect(line).toContain("$6.50");
    expect(line).toContain("$5.00");
    expect(line).toContain("2026-05-05T21:00:00.000Z");
  });

  test("a tenant token ceiling reads as tokens at the tenant's path", () => {
    const line = describeSpendHold(
      {
        scope: "tenant",
        measure: "tokens",
        window: "7d",
        limit: 1_000_000,
        spent: 1_200_000,
        since: "2026-05-05T00:00:00.000Z",
        releaseAt: "2026-05-06T00:00:00.000Z",
      },
      "work",
    );
    expect(line).toContain("`spend.ceiling.tokens7d`");
    expect(line).toContain("1,200,000 tokens");
  });
});
