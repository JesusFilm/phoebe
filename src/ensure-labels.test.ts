// Boot-time label existence tests (#67): the Phoebe-owned label set, and
// `ensureLabels` issues one idempotent `gh label create --force` per spec
// against the configured repo.

import { describe, expect, test } from "vite-plus/test";
import { ensureLabels, phoebeLabelSet, type GhRunner } from "./ensure-labels.ts";
import { PRIORITY_ORDER } from "./kinds/producer.ts";
import { PHOEBE_QUARANTINE_LABEL, PHOEBE_RETRY_LABEL } from "./quarantine.ts";
import { PHOEBE_TIER_LABEL_PREFIX } from "./tier.ts";

const singleRepoConfig = {
  repoSlug: "o/r",
  readyLabel: "ready-for-agent",
  researchLabel: "wayfinder:research",
  processingLabel: "processing",
  prOptOutLabel: "ready-for-human",
  priorityLabelPrefix: "priority:",
  bailTriageLabel: "needs-triage",
};

describe("phoebeLabelSet", () => {
  test("one spec per label, all scoped to the configured repo", () => {
    const specs = phoebeLabelSet(singleRepoConfig);
    expect(specs.map((s) => `${s.repoSlug}#${s.name}`)).toEqual([
      "o/r#ready-for-agent",
      "o/r#processing",
      "o/r#wayfinder:research",
      "o/r#ready-for-human",
      "o/r#needs-triage",
      `o/r#${PHOEBE_QUARANTINE_LABEL}`,
      `o/r#${PHOEBE_RETRY_LABEL}`,
      `o/r#${PHOEBE_TIER_LABEL_PREFIX}basic`,
      `o/r#${PHOEBE_TIER_LABEL_PREFIX}mid`,
      `o/r#${PHOEBE_TIER_LABEL_PREFIX}strong`,
      ...PRIORITY_ORDER.map((bucket) => `o/r#priority:${bucket}`),
    ]);
  });

  test("every spec carries a --force-able description and color", () => {
    for (const spec of phoebeLabelSet(singleRepoConfig)) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.color).toMatch(/^[0-9A-Fa-f]{6}$/);
    }
  });

  test("the four priority labels are built from the configured prefix, not a hardcoded one (#144)", () => {
    const specs = phoebeLabelSet({ ...singleRepoConfig, priorityLabelPrefix: "urgency/" });
    expect(specs.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "urgency/bug",
        "urgency/tracer",
        "urgency/polish",
        "urgency/refactor",
      ]),
    );
  });

  test("the bail-triage label is built from the configured field, not a hardcoded name (#143)", () => {
    const specs = phoebeLabelSet({ ...singleRepoConfig, bailTriageLabel: "needs-grilling" });
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(["needs-grilling"]));
    expect(specs.map((s) => s.name)).not.toContain("needs-triage");
  });
});

describe("ensureLabels", () => {
  test("issues one `gh label create --force` call per spec, scoped to its repo", () => {
    const calls: Array<{ args: string[]; repo?: string }> = [];
    const runner: GhRunner = (args, _opts, repo) => {
      calls.push({ args, repo });
    };
    ensureLabels(
      [
        {
          repoSlug: "o/r",
          name: "processing",
          description: "Phoebe is working this issue",
          color: "FBCA04",
        },
      ],
      runner,
    );
    expect(calls).toEqual([
      {
        args: [
          "label",
          "create",
          "processing",
          "--force",
          "--description",
          "Phoebe is working this issue",
          "--color",
          "FBCA04",
        ],
        repo: "o/r",
      },
    ]);
  });

  test("a claim and a quarantine both succeed on a repo where neither label exists yet", () => {
    const existing = new Set<string>();
    const runner: GhRunner = (args, _opts, repo) => {
      if (args[0] === "label" && args[1] === "create") {
        existing.add(`${repo}#${args[2]}`);
        return;
      }
      if (args[2] === "--add-label") {
        if (!existing.has(`${repo}#${args[3]}`)) {
          throw new Error(`'${args[3]}' not found`);
        }
      }
    };

    ensureLabels(phoebeLabelSet(singleRepoConfig), runner);

    expect(() =>
      runner(["issue", "edit", "1", "--add-label", "processing"], undefined, "o/r"),
    ).not.toThrow();
    expect(() =>
      runner(["issue", "edit", "1", "--add-label", PHOEBE_QUARANTINE_LABEL], undefined, "o/r"),
    ).not.toThrow();
  });

  test("a failing create call stops the sweep and propagates — boot fails loud rather than starting half-labelled", () => {
    const calls: string[] = [];
    const runner: GhRunner = (args) => {
      calls.push(args[2]!);
      if (args[2] === "processing") throw new Error("network error");
    };
    expect(() =>
      ensureLabels(
        [
          { repoSlug: "o/r", name: "ready-for-agent", description: "d", color: "0E8A16" },
          { repoSlug: "o/r", name: "processing", description: "d", color: "FBCA04" },
          { repoSlug: "o/r", name: "wayfinder:research", description: "d", color: "1D76DB" },
        ],
        runner,
      ),
    ).toThrow("network error");
    expect(calls).toEqual(["ready-for-agent", "processing"]);
  });
});
