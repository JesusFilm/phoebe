// What each setting is called and what it does, in the words the config form
// shows beside its control (config-form.tsx).
//
// The companion hands the form the settings as facts: a path, a type, what the
// file says. This is the other half, the part written for a person: a name the
// way the project settings say "Display name" rather than `label`, and one
// sentence on what the setting decides. A path this table does not know is shown
// as itself, so a setting the catalogue gains before this does is still a row.

export type SettingCopy = {
  /** The name a person reads, over the path. */
  label: string;
  /** One sentence on what it decides. */
  description: string;
};

export const SETTING_COPY: Readonly<Record<string, SettingCopy>> = {
  // ── the repository
  repoSlug: {
    label: "Repository",
    description: "The GitHub owner/repo Phoebe works, passed to every gh call.",
  },
  repoUrl: {
    label: "Clone URL",
    description: "The HTTPS URL the container clones the repository from.",
  },
  defaultBranch: {
    label: "Default branch",
    description: "The branch pull requests target and worktrees start from.",
  },
  branchPrefix: {
    label: "Branch prefix",
    description: "What every branch Phoebe pushes starts with; an issue's is <prefix>issue-<n>.",
  },
  // ── the labels
  readyLabel: {
    label: "Ready label",
    description: "Only issues wearing this label are picked up as work.",
  },
  researchLabel: {
    label: "Research label",
    description: "Open issues wearing this label are picked up by the research kind.",
  },
  processingLabel: {
    label: "Processing label",
    description: "Put on an issue the moment Phoebe claims it.",
  },
  mergedLabel: {
    label: "Merged label",
    description: "Marks a feature member whose own pull request has merged and awaits integration.",
  },
  featureLabel: {
    label: "Feature label",
    description: "A parent issue wearing this puts its children on one feature branch.",
  },
  prOptOutLabel: {
    label: "Hands-off label",
    description: "Pull requests wearing this label are left out of every scan.",
  },
  // ── the commands
  installCommand: {
    label: "Install command",
    description: "Installs dependencies in each worktree before the agent runs.",
  },
  checkCommand: {
    label: "Check command",
    description: "The lint and type gate; prompts see it as {{CHECK_COMMAND}}.",
  },
  testCommand: {
    label: "Test command",
    description: "The test gate; prompts see it as {{TEST_COMMAND}}.",
  },
  readyCommand: {
    label: "Ready command",
    description: "The all-in-one gate the agent runs before it pushes.",
  },
  // ── how issues are read
  blockedByPattern: {
    label: "Blocked-by pattern",
    description:
      "A regular expression that finds a blocker in an issue's text; its first group must be the issue number.",
  },
  partOfPattern: {
    label: "Part-of pattern",
    description:
      "A regular expression that finds a feature membership written in an issue's text; its first group must be the parent's number.",
  },
  reviewsSuccessHeading: {
    label: "Reviews heading",
    description:
      "The heading the reviews agent puts on its summary comment. Phoebe finds the summary by it, so it has to be unique.",
  },
  // ── which pull requests are in scope
  prScope: {
    label: "Pull request scope",
    description:
      "phoebe scans only branches with the prefix above; all scans every pull request in the repository.",
  },
  draftPrs: {
    label: "Draft pull requests",
    description:
      "skip-non-phoebe leaves other people's drafts alone; skip-all leaves every draft alone; include treats drafts like the rest.",
  },
  featureBranchCatchUp: {
    label: "Keep feature branches current",
    description:
      "Whether the conflicts kind keeps a live feature branch up to date with the default branch.",
  },
  // ── the agent
  defaultProvider: {
    label: "Provider",
    description: "Which agent CLI does the work: cursor, claude or codex.",
  },
  model: {
    label: "Model",
    description: "The model the provider runs. Empty means the provider's default.",
  },
  effort: {
    label: "Reasoning effort",
    description:
      "How hard the model thinks. Only claude honours it: low, medium, high, xhigh or max.",
  },
  runTimeoutMs: {
    label: "Run budget",
    description: "How long one unit of work may take, in milliseconds, before it is stopped.",
  },
  maxUnproductiveRuns: {
    label: "Unproductive runs before quarantine",
    description: "How many runs in a row may end with nothing to show before a unit is set aside.",
  },
  // ── the deployment
  "engine.source": {
    label: "Engine source",
    description:
      "Where the engine comes from: github for a checkout at a ref, local for a mounted one.",
  },
  "engine.ref": {
    label: "Engine ref",
    description:
      "The branch, tag or commit of the engine this deployment runs. Saving it runs an upgrade, so the new ref's migrations run with the move.",
  },
  "engine.repo": {
    label: "Engine repository",
    description: "The repository the engine is checked out from, when it is a fork.",
  },
  "reporting.maintainers": {
    label: "Report faults to the maintainers",
    description: "Send Phoebe's own crashes, never a tenant's, to the Phoebe project's Sentry.",
  },
  "reporting.dsn": {
    label: "Report faults to your own Sentry",
    description:
      "A Sentry or GlitchTip DSN of your own. Both targets set means both get every report.",
  },
  "reporting.includeRef": {
    label: "Include the repository in reports",
    description:
      "Whether a crash report names the repository and the unit it was working. Off, they read as redacted.",
  },
  "workspace.depth": {
    label: "Discovery depth",
    description: "How many folder levels under the root are searched for children with a config.",
  },
  "workspace.tenants": {
    label: "Declared tenants",
    description:
      "The fleet named in the config, in the order it is supervised, instead of found on disk.",
  },
};

/** The copy for a path, or the path itself as the name with nothing more to say. */
export function settingCopy(path: string): SettingCopy {
  return SETTING_COPY[path] ?? { label: path, description: "" };
}
