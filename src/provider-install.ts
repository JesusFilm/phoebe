// Which agent CLIs a deployment's image installs, and the Dockerfile blocks that
// install them (#869).
//
// The shipped template (templates/container/Dockerfile) carries one block per
// provider, each pinned, each between a `# phoebe:provider <name>` line and a
// `# phoebe:end-provider <name>` line. That template is the one source of the
// blocks: `phoebe init` keeps the ones for the providers it was asked for and
// drops the rest, and the companion copies a block out of the same template to
// add a provider to a Dockerfile that lacks one (apps/desktop/src/harness.ts).
// The pins stay in the Dockerfile, where the dependency kinds and Renovate find
// them, rather than in code.
//
// Pure apart from the terminal question at the bottom, which `phoebe init`
// asks on a TTY.

import { createInterface } from "node:readline/promises";
import { PROVIDER_NAMES, type ProviderName } from "./config-schema.ts";

/** What `phoebe init` installs when nobody says otherwise. */
export const DEFAULT_INIT_PROVIDERS: readonly ProviderName[] = ["claude"];

/** The line that opens a provider's block. */
export function providerBlockStart(provider: ProviderName): string {
  return `# phoebe:provider ${provider}`;
}

/** The line that closes it. */
export function providerBlockEnd(provider: ProviderName): string {
  return `# phoebe:end-provider ${provider}`;
}

/**
 * Read a `--providers` value, or an answer to init's question: names separated
 * by commas or spaces, each one of {@link PROVIDER_NAMES}. Order is kept and a
 * repeat is dropped. An empty list or an unknown name throws, naming the three.
 */
export function parseProviders(raw: string): ProviderName[] {
  const names = raw
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new Error(`Name at least one provider: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const picked: ProviderName[] = [];
  for (const name of names) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown provider "${name}". Use any of: ${PROVIDER_NAMES.join(", ")}.`);
    }
    if (!picked.includes(name as ProviderName)) picked.push(name as ProviderName);
  }
  return picked;
}

/**
 * The provider a scaffolded config names, so the config and the image agree:
 * claude when it is among the ones installed, else the first one chosen.
 */
export function defaultProviderFor(providers: readonly ProviderName[]): ProviderName {
  if (providers.length === 0) throw new Error("No provider to make the default.");
  return providers.includes("claude") ? "claude" : providers[0]!;
}

/** Where one provider's block sits: the index of its start and end marker lines. */
function blockRange(
  lines: readonly string[],
  provider: ProviderName,
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trimEnd() === providerBlockStart(provider));
  if (start === -1) return null;
  const end = lines.findIndex(
    (line, index) => index > start && line.trimEnd() === providerBlockEnd(provider),
  );
  return end === -1 ? null : { start, end };
}

/**
 * One provider's block out of a Dockerfile, markers included, or null when the
 * file has no complete block for it.
 */
export function providerBlock(dockerfile: string, provider: ProviderName): string[] | null {
  const lines = dockerfile.split(/\r?\n/);
  const range = blockRange(lines, provider);
  return range === null ? null : lines.slice(range.start, range.end + 1);
}

/** The providers a Dockerfile carries a marked block for, in file order. */
export function providerBlocksIn(dockerfile: string): ProviderName[] {
  const lines = dockerfile.split(/\r?\n/);
  return PROVIDER_NAMES.flatMap((provider) => {
    const range = blockRange(lines, provider);
    return range === null ? [] : [{ provider, start: range.start }];
  })
    .sort((a, b) => a.start - b.start)
    .map(({ provider }) => provider);
}

/**
 * The provider a config should name to run on the image this Dockerfile
 * builds, by the rule {@link defaultProviderFor} applies at init. Null when it
 * carries no marked block to go by. `init --tenant` asks this of the workspace
 * root's image, so a new tenant names a CLI that image installs.
 */
export function providerForImage(dockerfile: string): ProviderName | null {
  const installed = providerBlocksIn(dockerfile);
  return installed.length === 0 ? null : defaultProviderFor(installed);
}

/**
 * The Dockerfile without one provider's marked block, and without the blank
 * line that separated it from what came before. Null when there is no such
 * block.
 */
export function removeProviderBlock(dockerfile: string, provider: ProviderName): string | null {
  const newline = dockerfile.includes("\r\n") ? "\r\n" : "\n";
  const lines = dockerfile.split(/\r?\n/);
  const range = blockRange(lines, provider);
  if (range === null) return null;
  let { start } = range;
  let { end } = range;
  if (start > 0 && lines[start - 1]!.trim() === "") start -= 1;
  else if (end < lines.length - 1 && lines[end + 1]!.trim() === "") end += 1;
  lines.splice(start, end - start + 1);
  return lines.join(newline);
}

/**
 * The scaffold's Dockerfile with a block for each of `providers` and none for
 * the rest. Throws when the template has no block for one that was asked for:
 * an image that cannot run the provider its config names is the failure this
 * exists to prevent.
 */
export function keepProviderBlocks(dockerfile: string, providers: readonly ProviderName[]): string {
  if (providers.length === 0) throw new Error("A scaffold needs at least one provider.");
  let kept = dockerfile;
  for (const provider of PROVIDER_NAMES) {
    if (providers.includes(provider)) {
      if (providerBlock(kept, provider) === null) {
        throw new Error(
          `The Dockerfile template has no \`${providerBlockStart(provider)}\` block to install it.`,
        );
      }
      continue;
    }
    kept = removeProviderBlock(kept, provider) ?? kept;
  }
  return kept;
}

/** The question `phoebe init` asks on a TTY. */
export const PROVIDERS_QUESTION =
  `Which agent CLIs should the image install? Any of ${PROVIDER_NAMES.join(", ")}, ` +
  `separated by commas  [${DEFAULT_INIT_PROVIDERS.join(",")}] > `;

/**
 * Ask which providers to install; null when there is no TTY to ask on. An
 * empty answer takes the default, and an answer that names no provider asks
 * again.
 */
export async function promptProviders(): Promise<ProviderName[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(PROVIDERS_QUESTION)).trim();
      if (answer === "") return [...DEFAULT_INIT_PROVIDERS];
      try {
        return parseProviders(answer);
      } catch (error) {
        process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}
