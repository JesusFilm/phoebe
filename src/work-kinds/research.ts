// The `research` kind: work the next wayfinder research ticket. Identical to
// `issues` but for the label, the prompt, and the words — which is the whole
// point of the issue-producer helper.

import type { PhoebeConfig } from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { issueProducerKind } from "./issue-producer.ts";

export function researchKind(config: PhoebeConfig): AnyWorkKindDefinition {
  return issueProducerKind({
    name: "research",
    promptFile: config.promptFiles.research,
    noun: `${config.researchLabel} ticket(s)`,
    unitNoun: "research ticket",
    verb: "Researching",
    listIssues: (ctx) => ctx.github.listResearchIssues(),
  });
}
