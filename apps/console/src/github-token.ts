// The GitHub half of the setup steps, as pure readings (setup-steps.tsx).
//
// GitHub cannot mint a fine-grained token for anyone, but since August 2025
// its creation page takes the token's name, owner, lifetime and permissions as
// query parameters. That is as close to "create it for me" as a PAT gets: the
// one thing the page cannot be told is which repository, so the operator picks
// that, and the companion checks the result against the repo before it saves.

import type { ConfigFieldFacts, GithubGrant, HarnessName } from "phoebe-agent/contracts";

/** The five grants, as GitHub's URL parameters name them, at the access Phoebe needs. */
export const TOKEN_PAGE_GRANTS: readonly [string, string][] = [
  ["contents", "write"],
  ["pull_requests", "write"],
  ["issues", "write"],
  ["actions", "read"],
];

/** The longest lifetime GitHub allows a fine-grained token, in days. */
export const TOKEN_LIFETIME_DAYS = 366;

/**
 * The `owner/repo` a config states, off its field facts, or null when the file
 * computes it or says nothing. The same reading harness.ts makes for the
 * provider.
 */
export function slugOf(fields: readonly ConfigFieldFacts[] | undefined): string | null {
  const field = fields?.find((candidate) => candidate.path === "repoSlug");
  if (field === undefined || field.state !== "set") return null;
  return typeof field.value === "string" && /^[^/\s]+\/[^/\s]+$/.test(field.value)
    ? field.value
    : null;
}

/**
 * GitHub's fine-grained token page, filled in for one repo: named after it,
 * owned by its owner, a year long, with the five grants ticked. The
 * repository itself has to be picked on the page; there is no parameter for
 * it, and the page says so beside the link.
 */
export function tokenPageUrl(slug: string): string {
  const [owner, repo] = slug.split("/") as [string, string];
  const params = new URLSearchParams({
    name: `Phoebe ${repo}`.slice(0, 40),
    description: `Phoebe works ${slug}: clones, pushes phoebe/ branches, opens PRs, moves issue labels, reads Actions.`,
    target_name: owner,
    expires_in: String(TOKEN_LIFETIME_DAYS),
  });
  for (const [permission, access] of TOKEN_PAGE_GRANTS) params.set(permission, access);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/**
 * Whether a slug is the one `phoebe init` scaffolds rather than a repository.
 * A token page opened for `your-org` would only send someone to a GitHub
 * error, so the step asks for the real slug first.
 */
export function isPlaceholderSlug(slug: string): boolean {
  return /^your-org\//i.test(slug) || /\/your-repo$/i.test(slug);
}

/** The env var a provider's key goes in, as the config's default `providerEnv` names it. */
export const PROVIDER_KEYS: Record<HarnessName, string> = {
  claude: "ANTHROPIC_API_KEY",
  cursor: "CURSOR_API_KEY",
  codex: "OPENAI_KEY",
};

/**
 * The env var this config reads a provider's key from: its `providerEnv`
 * override when it states one, else the default. Null when the file computes
 * it, since a guess would save the key where the agent does not look.
 */
export function providerKeyOf(
  fields: readonly ConfigFieldFacts[] | undefined,
  provider: HarnessName,
): string | null {
  const field = fields?.find((candidate) => candidate.path === `providerEnv.${provider}`);
  if (field === undefined || field.state === "unset") return PROVIDER_KEYS[provider];
  return field.state === "set" && typeof field.value === "string" && field.value !== ""
    ? field.value
    : null;
}

/** One line per grant, for the checklist under the field. */
export function grantReading(grant: GithubGrant): string {
  switch (grant.state) {
    case "granted":
      return `${grant.label}: granted`;
    case "missing":
      return `${grant.label}: missing (${grant.detail}). ${grant.why}`;
    case "unknown":
      return `${grant.label}: could not tell (${grant.detail})`;
  }
}

/** Whether a pasted value is the shape of a whole token rather than part of one. */
export function looksLikeToken(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}
