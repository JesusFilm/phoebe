// The `issues` kind: work the highest-priority workable ready-labelled ticket
// into a branch + PR. A prompt-only producer — everything but the label, the
// prompt, and the words is the shared issue-producer shape.

import type { PhoebeConfig } from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { issueProducerKind } from "./issue-producer.ts";

export function issuesKind(config: PhoebeConfig): AnyWorkKindDefinition {
  return issueProducerKind({
    name: "issues",
    promptFile: config.promptFiles.issue,
    noun: `${config.readyLabel} issue(s)`,
    unitNoun: "issue",
    verb: "Working",
    listIssues: (ctx) => ctx.github.listReadyIssues(),
  });
}
