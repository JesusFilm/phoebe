// One scrape, one render for the three shipped scaffold profiles (#72).
//
// Five dialects used to read and write `phoebe.config.ts`: two regex readers
// (`extractConfigValues`, `readFlatRepoFields`) that disagreed on escaped
// quotes, and three template writers (`renderTenantConfig`'s inline literal,
// plus `renderTemplate` over the flat and workspace templates) that disagreed
// on escaping. `readAuthoredFields`/`renderAuthoredConfig` replace all five:
// one escape-handling scrape, one renderer over the three shipped templates,
// both deriving their field list from the roster's `scaffold` column instead
// of a hand-written list that could (and did) drift from it.
//
// Every scaffold template carries its tokens bare (`repoSlug: {{REPO_SLUG}}`,
// no surrounding quotes) — `renderAuthoredConfig` splices in the full
// `JSON.stringify`d literal, so quoting is the renderer's job, not the
// template author's (closes #71 for these templates).

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readShippedFile } from "../package-resource.ts";
import {
  SCAFFOLD_FIELDS,
  scaffoldFieldsFor,
  type RosterField,
  type ScaffoldProfile,
} from "./roster.ts";

export type { ScaffoldProfile } from "./roster.ts";

/** The scaffold-authored subset of `PhoebeUserConfig` — every field at least
 *  one shipped template renders as a `{{TOKEN}}` (roster's `scaffold` column). */
export type AuthoredFields = Partial<Record<RosterField, string>>;

// The real published package name. Every scaffold template imports
// `PhoebeUserConfig` from it; unlike the roster fields it names no consumer
// value, so it is a fixed token rather than part of `AuthoredFields`.
const CLI_BIN = "phoebe-agent";

const PROFILE_TEMPLATE: Record<ScaffoldProfile, string> = {
  flat: "templates/phoebe.config.ts",
  workspace: "templates/phoebe.config.workspace.ts",
  tenant: "templates/phoebe.config.tenant.ts",
};

function fieldToToken(field: string): string {
  // installCommand -> INSTALL_COMMAND
  return field.replace(/([A-Z])/g, "_$1").toUpperCase();
}

/**
 * Scrape every scaffold-authored field out of a `phoebe.config.ts`-shaped
 * file. Regex over the source (not an import) so reconfiguring never
 * *executes* a consumer module. The escape-handling backreference pattern
 * correctly stops at the field's own quote character even when the value
 * contains an escaped one (`\"`) — the bug the naive char-class reader had.
 * Returns `{}` when `path` does not exist or does not parse as expected.
 */
export function readAuthoredFields(path: string): Partial<AuthoredFields> {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Partial<AuthoredFields> = {};
  for (const field of SCAFFOLD_FIELDS) {
    const match = new RegExp(`\\b${field}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(source);
    if (match) out[field] = match[2];
  }
  return out;
}

/**
 * Render one of the three shipped scaffold templates. `fields` need only
 * supply the profile's own scaffolded fields (see `scaffoldFieldsFor`) —
 * anything else is ignored. A profile field left unsupplied leaves its
 * `{{TOKEN}}` unsubstituted, which the leftover-token check below turns into
 * a clear error rather than a silently broken scaffold.
 */
export function renderAuthoredConfig(
  profile: ScaffoldProfile,
  fields: Partial<AuthoredFields>,
  opts: { packageRoot?: string } = {},
): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const source = readShippedFile(PROFILE_TEMPLATE[profile], opts.packageRoot, moduleDir);

  const tokens: Record<string, string> = { CLI_BIN };
  for (const field of scaffoldFieldsFor(profile)) {
    const value = fields[field];
    if (value !== undefined) tokens[fieldToToken(field)] = value;
  }

  let rendered = source;
  for (const [token, value] of Object.entries(tokens)) {
    rendered = rendered.split(`{{${token}}}`).join(JSON.stringify(value));
  }

  const leftover = /\{\{([A-Z_]+)\}\}/.exec(rendered);
  if (leftover) {
    throw new Error(
      `Scaffold template "${PROFILE_TEMPLATE[profile]}" contained an unrenderable ` +
        `placeholder \`{{${leftover[1]}}}\` — every {{TOKEN}} in a config template must map ` +
        `to a field the roster scaffolds for "${profile}", or CLI_BIN.`,
    );
  }
  return rendered;
}
