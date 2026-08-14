// Migration m002: add "research" to an explicit workOrder that lacks it.
//
// The research work kind was added after initial deployments shipped. A
// deployment with an explicit `workOrder` that pre-dates the research kind
// will silently skip every research unit because the orchestrator only runs
// work kinds listed in `workOrder`. This migration appends "research" to the
// array so research units are picked up without an operator having to know
// the field exists.
//
// Deployments that rely on the default `workOrder` are not affected: the
// default already includes "research", so detect returns null for them.
//
// Configs with a computed or spread `workOrder` are refused with the exact
// edit instruction — the operator makes the change by hand.

import { ConfigRefusal, configHandle, workKindInstruction } from "../config-handle.ts";
import type { Migration } from "../migrate.ts";

const KIND = "research";
const CONFIG_REL_PATH = "phoebe.config.ts";

export const addResearchToWorkOrderMigration: Migration = {
  id: "add-research-to-workorder",
  title: 'Add "research" to workOrder',
  appliesTo: ["solo-root", "workspace-root", "tenant"] as const,

  detect(_dir, readFile) {
    const content = readFile(CONFIG_REL_PATH);
    if (content === null) return null;

    // No explicit workOrder → the engine default already includes "research".
    if (!/\bworkOrder\s*:/.test(content)) return null;

    // Explicit workOrder — check if "research" is already present in the array.
    const match = /\bworkOrder\s*:\s*(\[(?:[^[\]]*)\])/.exec(content);
    if (match !== null) {
      const inner = match[1]!;
      if (inner.includes(`"${KIND}"`) || inner.includes(`'${KIND}'`)) return null;
    }
    // match === null means workOrder exists but not as a parseable plain literal
    // (e.g., computed expression). We still flag it as applicable — apply will
    // produce a ConfigRefusal, and the operator gets the exact edit instruction.

    return content;
  },

  describe() {
    return `add "${KIND}" to the workOrder array`;
  },

  apply(_dir, data, _readFile) {
    const content = data as string;
    const result = configHandle.appendWorkKind(content, KIND);
    if (result.ok) {
      return { [CONFIG_REL_PATH]: result.content };
    }
    return new ConfigRefusal(
      `${workKindInstruction(KIND)} (could not rewrite automatically: ${result.reason})`,
    );
  },
};

export default addResearchToWorkOrderMigration;
