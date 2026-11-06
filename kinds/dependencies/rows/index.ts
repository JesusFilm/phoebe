// The native source's rows. Rows for other ecosystems join this list as they
// land. A row runs nothing in a checkout with no project of its own, so a
// consumer pays only for the managers they use.

import { cargoRow } from "./cargo.ts";
import { npmRow } from "./npm.ts";
import { pnpmRow } from "./pnpm.ts";
import { pipRow, poetryRow, uvRow } from "./python.ts";
import type { Row, RowDeps } from "./row.ts";
import { yarnRow } from "./yarn.ts";

export function nativeRows(deps: RowDeps): Row[] {
  return [
    pnpmRow(deps),
    npmRow(deps),
    yarnRow(deps),
    cargoRow(deps),
    uvRow(deps),
    poetryRow(deps),
    pipRow(deps),
  ];
}
