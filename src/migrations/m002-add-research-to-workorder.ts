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

import {
  ConfigRefusal,
  REASON_WORKORDER_NOT_FOUND,
  configHandle,
  editConfigAppendWorkKind,
  workKindInstruction,
} from "../config-handle.ts";
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

    // Use the parser-based append to determine applicability.
    // "Not found" means the config uses the default workOrder, which already
    // includes "research" — not applicable.
    const probe = editConfigAppendWorkKind(content, KIND);
    if (!probe.ok && probe.reason === REASON_WORKORDER_NOT_FOUND) return null;
    // Already present (content unchanged after append attempt)
    if (probe.ok && probe.content === content) return null;

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
