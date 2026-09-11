// The one consent question (#474), owned here so `init` and `upgrade` ask it
// in the same words and neither has to import the other for it: whether
// Phoebe's own crash reports go to the maintainers. Asked on a TTY, once; the
// answer is a field in the config, and a present field is never asked again.

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { editConfigGetField, editConfigInsertFieldSource } from "./config-handle.ts";

/** The one consent question, asked by `init` and `upgrade` alike */
export const REPORTING_CONSENT_QUESTION =
  "Send Phoebe's own crash reports (boot and upgrade faults, nothing from your repos) " +
  "to the maintainers?  [y/N] > ";

/** Ask the question on the terminal; `null` when there is no TTY to ask on. */
export async function promptReportingConsent(): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(REPORTING_CONSENT_QUESTION)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Before the engine half moves the pin (#474): a config with no `reporting`
 * block has never been asked, so ask once and write the answer as a field —
 * `reporting: { maintainers: <answer> }`, in place on the same inode like the
 * ref rewrite. A present block, true or false, is an answer and is never asked
 * again. No TTY leaves the block absent, which reports nothing. A config the
 * handle cannot edit is left alone with a line saying so; the upgrade goes on.
 */
export async function ensureReportingConsent(opts: {
  configPath: string;
  ask: () => Promise<boolean | null>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<void> {
  let content: string;
  try {
    content = readFileSync(opts.configPath, "utf8");
  } catch (error) {
    opts.stderr(`reporting: could not read ${opts.configPath} (${describe(error)}) — not asking.`);
    return;
  }
  const existing = editConfigGetField(content, "reporting");
  if (!existing.ok) {
    opts.stderr(`reporting: could not read ${opts.configPath} (${existing.reason}) — not asking.`);
    return;
  }
  if (existing.found) return;
  const answer = await opts.ask();
  if (answer === null) return;
  const result = editConfigInsertFieldSource(content, "reporting", `{ maintainers: ${answer} }`);
  if (!result.ok) {
    opts.stderr(
      `reporting: could not write the answer to ${opts.configPath} (${result.reason}) — ` +
        `add \`reporting: { maintainers: ${answer} }\` by hand.`,
    );
    return;
  }
  try {
    writeFileSync(opts.configPath, result.content);
  } catch (error) {
    opts.stderr(
      `reporting: could not write the answer to ${opts.configPath} (${describe(error)}) — ` +
        `add \`reporting: { maintainers: ${answer} }\` by hand.`,
    );
    return;
  }
  opts.stdout(
    `reporting: { maintainers: ${answer} } written to ${opts.configPath}` +
      (answer ? " — thank you." : "."),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
