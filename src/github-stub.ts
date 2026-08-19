// The GitHub side of a cycle test (#281): `stubGitHub(overrides)` returns a
// `GitHubClient` where every method the test did not supply throws, naming
// itself. See docs/research/engine-runtime-seam.md, "The test double", for why
// this seam's double is designed for ergonomics rather than fidelity.
//
// It is a stub, not an in-memory GitHub. It holds no state, so there is no
// second implementation of GitHub here to keep in step with the real one. The
// loud throw is the point: a test declares exactly the surface it depends on,
// and a call it never declared fails at the callsite instead of quietly
// answering `[]` — the failure mode that let the idle report drift from the
// real selection path with nothing noticing.
//
// Test-only: no engine source imports it, and package.json keeps it out of the
// published files. It lives beside the interface it doubles so the two cannot
// drift.

import type { CycleGitHubClient, GitHubClient } from "./github-client.ts";

/**
 * The methods a test supplies. Both views are declared in one object: the
 * cycle-scoped client `forCycle()` hands back is backed by these same
 * overrides, so `openPrs`/`mergeInfo` sit beside the rest and no test has to
 * stub `forCycle` itself to reach them.
 */
export type GitHubStubOverrides = Partial<GitHubClient & CycleGitHubClient>;

/**
 * One view over the declared methods. A `Proxy` rather than a literal naming
 * every method: the interface is the only place those names belong, so a
 * method added there is covered here without an edit — and stays unstubbed,
 * loudly, for every test that does not ask for it. Only `get` is trapped, so
 * the view answers calls and nothing else; tests call these objects, they do
 * not enumerate them.
 */
function viewOf<T extends object>(label: string, declared: GitHubStubOverrides): T {
  const methods = declared as Record<string, unknown>;
  return new Proxy({} as T, {
    get(_target, prop) {
      // Not an interface read: `await`, `util.inspect` and the test runner's
      // own formatting probe objects for these, and a thrower here would turn
      // a failed assertion's diff into a crash somewhere else entirely.
      if (typeof prop !== "string" || prop === "then") return undefined;
      return methods[prop] ?? unstubbed(label, prop);
    },
  });
}

function unstubbed(label: string, method: string): () => never {
  return () => {
    throw new Error(
      `stubGitHub: ${label}.${method}() was called, but this test did not stub it. ` +
        `Either the test's declared surface is incomplete, or the code under test ` +
        `is reaching for GitHub where it should not.`,
    );
  };
}

/** Build a `GitHubClient` from the methods a test declares. The rest throw. */
export function stubGitHub(overrides: GitHubStubOverrides = {}): GitHubClient {
  const cycle = viewOf<CycleGitHubClient>("cycle", overrides);
  // The one method the stub answers for itself, so a test declares `openPrs`
  // and `mergeInfo` alongside the rest instead of assembling the cycle-scoped
  // view by hand. A test that supplies its own `forCycle` still wins.
  return viewOf<GitHubClient>("github", { forCycle: () => cycle, ...overrides });
}
