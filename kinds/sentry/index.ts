// The `sentry` catalog kind (#469): poll one Sentry project for unresolved
// error groups, triage each new one against the tenant's repository with a
// read-only agent run, and file a GitHub issue that clears the front-loading
// bar in docs/preparing-work.md — the located cause and the decision, not the
// symptom. The `issues` kind picks the issue up on a later cycle.
//
// It ships in the engine and registers only when a tenant declares it
// (`path: "phoebe-agent/kinds/sentry"` under `pipelines.<pipeline>.kinds.sentry`),
// so it may value-import engine helpers where a tenant module could not. After
// registration the engine cannot tell it from a custom kind.
//
// Shape, in the map's words:
//   - one unit is one group (`sentry:<groupId>`); `revision` is the latest
//     event's release, so a re-triage costs a run only when a release moved;
//   - four option gates (window, minEvents, environments, levels) go into the
//     list call, and `is:unresolved` defines a candidate rather than gating one;
//   - the watermark is an HTML marker in the filed issue, read back by one
//     GitHub search per cycle across every state, with the regression rule of
//     watermark.ts on top;
//   - the agent reads the repo and the crash from scratch and writes a draft;
//     the **kind** files from it, so the marker and the labels cannot be
//     forgotten and the agent never holds the Sentry token.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PhoebeConfig, ProviderName } from "../../src/config-schema.ts";
import { addLabelCreatingIfMissing, type PhoebeLabel } from "../../src/labels.ts";
import {
  defineWorkKind,
  type WorkKindCtx,
  type WorkKindDefinition,
  type WorkKindRunCtx,
  type WorkKindSkip,
} from "../../src/work-kinds/definition.ts";
import {
  createSentrySource,
  type SentryEvent,
  type SentryGroup,
  type SentrySource,
} from "./adapter.ts";
import { resolveSentryOptions, type SentryKindOptions } from "./options.ts";
import {
  labelsFor,
  parseTriageDraft,
  renderBody,
  renderDuplicateComment,
  renderTitle,
  TRIAGE_FILE,
  type ParsedTriage,
} from "./triage.ts";
import {
  compareByLoudness,
  decideGroup,
  MARKER_TEXT,
  parseMarker,
  type FiledIssue,
} from "./watermark.ts";

export const SENTRY_KIND_NAME = "sentry";
export const SENTRY_TOKEN_ENV = "SENTRY_AUTH_TOKEN";

/** The kind's own prompt, an absolute path into the engine checkout (#473). */
export const SENTRY_PROMPT_FILE = join(import.meta.dirname, "prompt.md");

/**
 * The most capable model per provider, the kind's definition-level default
 * (#472): one triage per group per release is cheap next to a confident wrong
 * ticket. Cursor is left to the tenant's `defaultModels`. Overridable on the
 * block like any kind.
 */
export const MOST_CAPABLE_MODEL: Partial<Record<ProviderName, string>> = {
  claude: "claude-opus-5",
  codex: "gpt-5.4",
};
export const TRIAGE_EFFORT = "high";

/** One unit: one unresolved group, with the latest event already in hand. */
export type SentryUnit = {
  ref: string;
  revision?: string;
  group: SentryGroup;
  event: SentryEvent;
  /** The closed issue this is a regression of (#471), when it is one. */
  regressionOf: number | null;
};

export type SentryGathered = {
  /** Groups that passed the gates this cycle, filed or not. */
  total: number;
  /** The unfiled ones, loudest first, latest event attached. */
  candidates: readonly SentryUnit[];
  /** Why the rest were turned away. */
  skipped: readonly WorkKindSkip[];
};

/** Test seam: the collector behind the kind. */
export type SentryKindDeps = {
  createSource?: (options: SentryKindOptions, token: string) => SentrySource;
};

function countSkips(reasons: Iterable<string>): WorkKindSkip[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

/** Group id → the issues linked to it, out of one search across all states. */
function filedByGroup(ctx: WorkKindCtx): Map<string, FiledIssue[]> {
  const filed = new Map<string, FiledIssue[]>();
  for (const hit of ctx.github.listIssuesMentioning(MARKER_TEXT)) {
    const groupId = parseMarker(hit.body);
    if (groupId === null) continue;
    const list = filed.get(groupId) ?? [];
    list.push({
      number: hit.number,
      state: hit.state,
      stateReason: hit.stateReason,
      closedAt: hit.closedAt,
    });
    filed.set(groupId, list);
  }
  return filed;
}

export function createSentryKind(
  config: PhoebeConfig,
  options: SentryKindOptions,
  deps: SentryKindDeps = {},
): WorkKindDefinition<SentryGathered, SentryUnit> {
  const createSource =
    deps.createSource ?? ((opts, token) => createSentrySource({ options: opts, token }));

  const filedLabel: PhoebeLabel = {
    name: options.label,
    description: "Filed by Phoebe from a Sentry error group",
  };
  const triagedLabel: PhoebeLabel = {
    name: options.triagedLabel,
    description: "Phoebe located the cause; a human flips this to the ready label",
  };
  const readyLabel: PhoebeLabel = {
    name: config.readyLabel,
    description: "Ready for Phoebe to work",
  };
  const labelOf = (name: string): PhoebeLabel =>
    name === options.triagedLabel
      ? triagedLabel
      : name === config.readyLabel
        ? readyLabel
        : filedLabel;

  const definitionModel = MOST_CAPABLE_MODEL[config.defaultProvider];

  return defineWorkKind<SentryGathered, SentryUnit>({
    name: SENTRY_KIND_NAME,
    oneShotEligible: true,
    promptFile: SENTRY_PROMPT_FILE,
    workspace: "readonly",
    requiredEnv: [SENTRY_TOKEN_ENV],
    // Deliberately no `agentEnv`: the agent reads Sentry from scratch, never
    // from the API, so the token has no business in a prompt-driven child.
    ...(definitionModel !== undefined ? { model: definitionModel } : {}),
    effort: TRIAGE_EFFORT,
    report: {
      noun: "Sentry group(s)",
      describe: (unit) => `triage for ${unit.ref} (${unit.group.title})`,
    },

    async fetch(ctx) {
      const token = ctx.env[SENTRY_TOKEN_ENV];
      if (token === undefined || token.trim().length === 0) {
        throw new Error(
          `${SENTRY_TOKEN_ENV} is not set — the boot check should have refused this.`,
        );
      }
      const source = createSource(options, token);
      // A failed list kills the cycle by the contract: a 401/403/404 here is a
      // misconfiguration the restart loop surfaces, not a unit to drop.
      const groups = await source.listUnresolvedGroups();
      const filed = filedByGroup(ctx);
      const skipped: string[] = [];
      const candidates: SentryUnit[] = [];
      for (const group of [...groups].sort(compareByLoudness)) {
        const decision = decideGroup(filed.get(group.id) ?? [], group.lastSeen);
        if (decision.action === "skip") {
          skipped.push(decision.reason);
          continue;
        }
        let event: SentryEvent;
        try {
          event = await source.latestEvent(group.id);
        } catch (error) {
          ctx.log(
            `sentry:${group.id}: could not read the latest event — dropping it this cycle. ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          skipped.push("latest event unavailable");
          continue;
        }
        candidates.push({
          ref: `sentry:${group.id}`,
          ...(event.release !== null ? { revision: event.release } : {}),
          group,
          event,
          regressionOf: decision.regressionOf,
        });
      }
      return { total: groups.length, candidates, skipped: countSkips(skipped) };
    },

    select(gathered, ctx) {
      const skipped = [...gathered.skipped];
      let inFlight = 0;
      let quarantined = 0;
      let unit: SentryUnit | null = null;
      for (const candidate of gathered.candidates) {
        if (ctx.inFlight.has(candidate.ref)) {
          inFlight += 1;
          continue;
        }
        if (ctx.quarantined.has(candidate.ref)) {
          quarantined += 1;
          continue;
        }
        unit = candidate;
        break;
      }
      if (inFlight > 0) skipped.push({ reason: "in flight", count: inFlight });
      if (quarantined > 0) skipped.push({ reason: "quarantined in memory", count: quarantined });
      return { unit, skipped, total: gathered.total };
    },

    async run(unit, ctx) {
      const scratch = ctx.workspace.scratch;
      const groupPath = join(scratch, "group.json");
      const eventPath = join(scratch, "event.json");
      const triagePath = join(scratch, TRIAGE_FILE);
      writeFileSync(groupPath, `${JSON.stringify(unit.group.raw, null, 2)}\n`);
      writeFileSync(eventPath, `${JSON.stringify(unit.event.raw, null, 2)}\n`);

      await ctx.agent.run({
        promptArgs: {
          SENTRY_TITLE: unit.group.title,
          SENTRY_CULPRIT: unit.group.culprit,
          SENTRY_LEVEL: unit.group.level,
          SENTRY_COUNT: String(unit.group.count),
          SENTRY_WINDOW: options.window,
          SENTRY_PERMALINK: unit.group.permalink,
          SENTRY_RELEASE: unit.event.release ?? "(none on the latest event)",
          SENTRY_TRANSACTION: unit.event.transaction ?? "(unknown)",
          SENTRY_ENVIRONMENT: unit.event.environment ?? "(unknown)",
          REGRESSION_NOTE:
            unit.regressionOf === null
              ? ""
              : `This group was fixed before: #${unit.regressionOf} closed as completed and Sentry has seen the crash again since. Say whether the fix regressed or never covered this path.`,
          SCRATCH_DIR: scratch,
          GROUP_JSON: groupPath,
          EVENT_JSON: eventPath,
          TRIAGE_JSON: triagePath,
        },
      });

      if (!existsSync(triagePath)) {
        throw new Error(
          `the triage agent left no ${TRIAGE_FILE} in ${scratch} — nothing to file; ` +
            `the run counts as failed and the group is retried by the timeout rules.`,
        );
      }
      const triage: ParsedTriage = parseTriageDraft(readFileSync(triagePath, "utf8"));
      if (!triage.ok) {
        ctx.log(
          `${unit.ref}: the draft could not be parsed (${triage.problem}) — filing as not ready.`,
        );
      }

      const symptom = {
        group: unit.group,
        event: unit.event,
        options,
        regressionOf: unit.regressionOf,
      };
      const issueNumber = ctx.github.createIssue({
        title: renderTitle(unit.group),
        body: renderBody(symptom, triage),
      });
      for (const label of labelsFor(triage, options, config.readyLabel)) {
        addLabelCreatingIfMissing(ctx.github, issueNumber, labelOf(label), (line) => ctx.log(line));
      }
      const verdict = triage.ok ? triage.draft.verdict : "not-ready";
      ctx.log(
        `${unit.ref}: filed #${issueNumber} (${verdict})` +
          (unit.regressionOf !== null ? ` as a regression of #${unit.regressionOf}` : "") +
          ".",
      );

      const duplicateOf = triage.ok ? triage.draft.duplicateOf : undefined;
      if (duplicateOf !== undefined) {
        if (ctx.github.issueState(duplicateOf).state === "open") {
          ctx.github.postUnitComment(
            { objectType: "issue", id: duplicateOf },
            renderDuplicateComment({ ...symptom, filedIssueNumber: issueNumber }),
          );
          ctx.log(`${unit.ref}: noted on the open duplicate #${duplicateOf}.`);
        } else {
          ctx.log(
            `${unit.ref}: the named duplicate #${duplicateOf} is closed — no comment posted.`,
          );
        }
      }
    },
  });
}

/**
 * The catalog entry point: the loader hands a factory the resolved config and
 * the block's root options. Validation throws here, at registration, so a bad
 * block fails `phoebe pipelines` and the pipeline's boot rather than a unit.
 */
export default function sentryKind(
  config: PhoebeConfig,
  options: unknown,
): WorkKindDefinition<SentryGathered, SentryUnit> {
  return createSentryKind(config, resolveSentryOptions(options, `kinds.${SENTRY_KIND_NAME}`));
}

/** For a `run` caller's benefit: the surface `run` needs, named. */
export type SentryRunCtx = WorkKindRunCtx;
