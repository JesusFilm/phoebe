// The settings a config form can offer, read off a config's source.
//
// The list is the settings catalogue's (src/settings-catalogue.ts): every
// setting a file can carry at the top of the config, which is also every one
// `config set` will write from a form. Two kinds are left out. A setting with no
// file field has nothing to read or write here, and the `deployment` block is
// closed to `config set`, so a form over it would offer edits that are refused.
//
// Read as source, never loaded, for the reason install-facts.ts gives: loading a
// config runs the operator's TypeScript in the companion's own process. So a
// value that is not a plain literal is handed over as it is written, and the
// form shows it without offering to replace it.

import type { ConfigFieldFacts } from "phoebe-agent/contracts";
import { editConfigGetField } from "../../../src/config-handle.ts";
import { CONFIG_DEFAULTS } from "../../../src/config-schema.ts";
import { SETTINGS } from "../../../src/settings-catalogue.ts";

/** The catalogue's settings a form offers: a file field, at the top of the config. */
const FORM_SETTINGS = SETTINGS.filter(
  (setting) => setting.envOnly !== true && !setting.path.includes("."),
);

/**
 * Every form setting with what `source` says about it, in the catalogue's
 * order. Empty when the config will not parse: a form over a file nobody could
 * read would be a form of guesses, and the file view is still there.
 */
export function configFieldsOf(source: string): ConfigFieldFacts[] {
  const fields: ConfigFieldFacts[] = [];
  for (const setting of FORM_SETTINGS) {
    const read = editConfigGetField(source, setting.path);
    if (!read.ok) return [];
    const fallback = (CONFIG_DEFAULTS as Record<string, unknown>)[setting.path];
    fields.push({
      path: setting.path,
      env: setting.env,
      type: setting.type,
      ...(setting.values === undefined ? {} : { values: setting.values }),
      ...(!read.found
        ? { state: "unset" as const }
        : read.literal === undefined
          ? { state: "computed" as const, raw: read.raw }
          : { state: "set" as const, value: read.literal }),
      ...(typeof fallback === "string" ||
      typeof fallback === "number" ||
      typeof fallback === "boolean"
        ? { default: fallback }
        : {}),
    });
  }
  return fields;
}
