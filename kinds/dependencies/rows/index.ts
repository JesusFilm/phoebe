// The native source's rows. Rows for other ecosystems join these lists as they
// land. A row runs nothing in a checkout with no project of its own, so a
// consumer pays only for the managers they use.

import { actionsRow, type ActionsRowDeps } from "./actions.ts";
import { npmRow } from "./npm.ts";
import { pnpmRow } from "./pnpm.ts";
import type { CandidateRow, Row, RowDeps } from "./row.ts";
import { yarnRow } from "./yarn.ts";

export function nativeRows(deps: RowDeps): Row[] {
  return [pnpmRow(deps), npmRow(deps), yarnRow(deps)];
}

/** The rows that ask what is newer themselves, because deps.dev cannot answer for them. */
export function candidateRows(deps: ActionsRowDeps): CandidateRow[] {
  return [actionsRow(deps)];
}
