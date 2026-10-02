// What `phoebe init` scaffolded. Lives here rather than in src/init.ts so an
// install tab can render the result of a scaffold without loading the
// filesystem code that produced it (#527 §4).

/** Init scaffold profile — which file set lands under the target dir. */
export type InitProfile = "solo" | "workspace" | "tenant";

/** Which files the scaffold wrote, updated, and deliberately left alone. */
export type InitReport = {
  /** New files written (destination paths, relative to the target dir). */
  created: string[];
  /** `.gitignore` entries appended in-place (destination paths). */
  updated: string[];
  /** Existing files left alone (destination paths). */
  skipped: string[];
};

/** A solo or workspace scaffold: a file list and where it landed. */
export type InitScaffoldOutcome = InitReport & {
  profile: "solo" | "workspace";
  /** Absolute path of the directory the scaffold landed in. */
  targetDir: string;
};

/** A workspace child's in-tree install, which also settles the child's identity. */
export type InitTenantOutcome = InitReport & {
  profile: "tenant";
  targetDir: string;
  /**
   * The authoritative slug and url written into the child's config, after
   * origin prefill and credential stripping.
   */
  tenant: { repoSlug: string; repoUrl: string };
};

/**
 * The init verb's outcome, closed over the profiles. A reader that only wants
 * the file lists can treat either arm as an {@link InitReport} — the three
 * arrays sit at the top level for that reason.
 */
export type InitOutcome = InitScaffoldOutcome | InitTenantOutcome;
