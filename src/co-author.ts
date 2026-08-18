// Co-author credit for issue-derived work (#198): the human who filed the issue
// gets a `Co-authored-by:` trailer on the commits Phoebe produces for it, using
// the `<id>+<login>@users.noreply.github.com` address GitHub links back to the
// account. Pure resolution over injected lookups; the git side lives in
// `git-model.ts` (`appendTrailerToCommits`) and the wiring in `main.ts`.

export type GitHubUser = { login: string; id: number; type: string };

export type CoAuthorLookups = {
  /** The issue's author login, or null when the account is gone (`ghost`). */
  issueAuthorLogin: (issueNumber: number) => string | null;
  /** `GET /users/<login>` — null (or a throw) when the user cannot be fetched. */
  lookupUser: (login: string) => GitHubUser | null;
};

/** The trailer line GitHub resolves to `user`'s account. */
export function coAuthorTrailer(user: Pick<GitHubUser, "login" | "id">): string {
  return `Co-authored-by: ${user.login} <${user.id}+${user.login}@users.noreply.github.com>`;
}

/**
 * Resolve the trailer crediting issue `issueNumber`'s author, or null when
 * there is nobody to credit: no author, a bot (bots need no contribution
 * credit, and `dependabot[bot]`-style logins are not people), or a lookup that
 * fails. Never throws — credit is best-effort and must not fail the work unit.
 */
export function resolveIssueCoAuthorTrailer(
  issueNumber: number,
  lookups: CoAuthorLookups,
): string | null {
  try {
    const login = lookups.issueAuthorLogin(issueNumber);
    if (login === null || login.length === 0 || login.endsWith("[bot]")) return null;
    const user = lookups.lookupUser(login);
    if (user === null || user.type !== "User") return null;
    return coAuthorTrailer(user);
  } catch {
    return null;
  }
}
