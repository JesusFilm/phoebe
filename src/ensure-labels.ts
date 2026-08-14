// Boot-time label existence (#67). Every label the engine writes —
// `readyLabel`/`processingLabel` (the claim/reclaim flip, #15/#81),
// `researchLabel` (the wayfinder queue), `prOptOutLabel` (`ready-for-human`,
// the PR hand-back signal a human must be able to apply),
// `PHOEBE_QUARANTINE_LABEL` (#75), `PHOEBE_RETRY_LABEL` (#136, the
// deliberate un-stick escape hatch), the three `phoebe:tier:*` labels (#155,
// a human-placed per-ticket model/effort override), and the four
// `priorityLabelPrefix`-prefixed priority labels (#144, a human-placed
// override that outranks `classifyPriority`'s title/body keyword cascade),
// and `bailTriageLabel` (#143, the landing zone a structural-bail
// choreography moves an issue to — `missing-prerequisite` / `external-dep` /
// `unclear-scope`) — is a Phoebe-owned constant the user never types and has
// no reason to know exists. Nothing in this repo ever
// created them: docs/phoebe-core-onboarding.md documented creating three of
// the five *by hand*, and never mentioned quarantine at all, so a fresh repo
// silently drops every write against a label that doesn't exist yet
// (quarantine writes swallowed or uncaught; a missing `processingLabel`
// ejects claimed issues from the queue with no PR and no visible failure).
//
// `gh label create --force` is idempotent — it updates rather than errors
// when the label already exists — so this runs unconditionally once per
// process at startup (`ensureClone`'s neighbour in the boot sequence), not
// per write. The per-write placement was fine when the only caller was
// quarantine (rare by construction); `processingLabel` is written on every
// claim, and an extra round trip per claim is not free.

import { PRIORITY_ORDER } from "./kinds/producer.ts";
import { PHOEBE_QUARANTINE_LABEL, PHOEBE_RETRY_LABEL } from "./quarantine.ts";
import { TIER_BUNDLES, PHOEBE_TIER_LABEL_PREFIX, type Tier } from "./tier.ts";

export type LabelSpec = {
  repoSlug: string;
  name: string;
  description: string;
  color: string;
};

/** Same shape as `main.ts`'s `gh` wrapper — injected so tests assert argv. */
export type GhRunner = (args: string[], opts?: { input?: string }, repo?: string) => void;

/** The Phoebe-owned label set this engine writes, all on the one configured repo. */
export function phoebeLabelSet(config: {
  repoSlug: string;
  readyLabel: string;
  researchLabel: string;
  processingLabel: string;
  prOptOutLabel: string;
  priorityLabelPrefix: string;
  bailTriageLabel: string;
}): LabelSpec[] {
  return [
    {
      repoSlug: config.repoSlug,
      name: config.readyLabel,
      description: "Phoebe may pick this issue up",
      color: "0E8A16",
    },
    {
      repoSlug: config.repoSlug,
      name: config.processingLabel,
      description: "Phoebe is working this issue",
      color: "FBCA04",
    },
    {
      repoSlug: config.repoSlug,
      name: config.researchLabel,
      description: "Phoebe's wayfinder research queue",
      color: "1D76DB",
    },
    {
      repoSlug: config.repoSlug,
      name: config.prOptOutLabel,
      description: "Hand this PR back to a human — Phoebe skips it",
      color: "D93F0B",
    },
    {
      repoSlug: config.repoSlug,
      name: config.bailTriageLabel,
      description:
        "Landing zone for a structural bail — missing prerequisite, external dependency, or unclear scope",
      color: "5319E7",
    },
    {
      repoSlug: config.repoSlug,
      name: PHOEBE_QUARANTINE_LABEL,
      description: "Phoebe quarantined this unit after repeated failures",
      color: "B60205",
    },
    {
      repoSlug: config.repoSlug,
      name: PHOEBE_RETRY_LABEL,
      description: "Retry this unit as-is — un-sticks it and resets its counters",
      color: "0E8A16",
    },
    ...TIER_LABEL_SPECS(config.repoSlug),
    ...PRIORITY_LABEL_SPECS(config.repoSlug, config.priorityLabelPrefix),
  ];
}

const TIER_LABEL_DESCRIPTIONS: Record<Tier, string> = {
  basic: "Run this unit cheap — Sonnet, low effort",
  mid: "Run this unit at the tenant default — Sonnet, high effort",
  strong: "Run this unit on Opus, high effort — a human placed this deliberately",
};

const TIER_LABEL_COLOR = "5319E7";

/** The three `phoebe:tier:*` labels (#155), provisioned fleet-wide like the quarantine/retry labels. */
function TIER_LABEL_SPECS(repoSlug: string): LabelSpec[] {
  return (Object.keys(TIER_BUNDLES) as Tier[]).map((tier) => ({
    repoSlug,
    name: `${PHOEBE_TIER_LABEL_PREFIX}${tier}`,
    description: TIER_LABEL_DESCRIPTIONS[tier],
    color: TIER_LABEL_COLOR,
  }));
}

const PRIORITY_LABEL_DESCRIPTIONS: Record<(typeof PRIORITY_ORDER)[number], string> = {
  bug: "Priority override: classify this issue as a bug fix regardless of wording",
  tracer: "Priority override: classify this issue as a tracer bullet regardless of wording",
  polish: "Priority override: classify this issue as polish regardless of wording",
  refactor: "Priority override: classify this issue as a refactor regardless of wording",
};

const PRIORITY_LABEL_COLOR = "C5DEF5";

/** The four `<priorityLabelPrefix>bug`/`tracer`/`polish`/`refactor` labels (#144), which outrank `classifyPriority`'s title/body keyword cascade. */
function PRIORITY_LABEL_SPECS(repoSlug: string, priorityLabelPrefix: string): LabelSpec[] {
  return PRIORITY_ORDER.map((bucket) => ({
    repoSlug,
    name: `${priorityLabelPrefix}${bucket}`,
    description: PRIORITY_LABEL_DESCRIPTIONS[bucket],
    color: PRIORITY_LABEL_COLOR,
  }));
}

/** `gh label create --force`, once per spec — safe to call unconditionally. */
export function ensureLabels(labels: readonly LabelSpec[], gh: GhRunner): void {
  for (const label of labels) {
    gh(
      [
        "label",
        "create",
        label.name,
        "--force",
        "--description",
        label.description,
        "--color",
        label.color,
      ],
      undefined,
      label.repoSlug,
    );
  }
}
