// Setting up the machine the companion runs on.
//
// A deployment runs under Docker Compose, so a machine with no Docker, or a
// Docker that is not running, is a machine on which nothing local can start.
// #522 §2 had the companion check for Docker and never install it: a sentence
// and a link. The revision here keeps the sentence and adds the button under
// it. The companion plans what it would run, shows that command before
// anything happens, and runs it only on a click, through the machine's own
// package manager or launcher, with the OS asking for whatever permission the
// step needs. It downloads no installer of its own.
//
// Everything is a plan first and a run second, because the plan is what the
// window renders and the run is what the operator agreed to. A step that cannot
// be offered, because the package manager is not there, is not a missing
// button: it is `blocked`, with why and where to go instead.

/** What the companion can set up. One for now; Tailscale joins with remote access. */
export type BootstrapTool = "docker";

/** What is wrong with the tool: it is absent, or present but not running. */
export type BootstrapNeed = "install" | "start";

/** One thing the companion offers to run, shown in full before it does. */
export type BootstrapStep = {
  tool: BootstrapTool;
  need: BootstrapNeed;
  /** The command, as one shell line, exactly as it will be run. */
  command: string;
  /** Whether the OS will ask for permission (UAC, a password prompt, polkit). */
  elevates: boolean;
  /** What to expect after it runs, when there is something to say. */
  note: string | null;
};

/** A step that cannot be offered on this machine, and where to go instead. */
export type BootstrapBlocked = {
  tool: BootstrapTool;
  need: BootstrapNeed;
  reason: string;
  link: string;
};

/**
 * What this machine needs and what the companion can do about it. Both lists
 * empty means there is nothing to do. The plan is read fresh on every ask,
 * because Docker Desktop starting is a thing that happens between two reads.
 */
export type BootstrapPlan = {
  steps: BootstrapStep[];
  blocked: BootstrapBlocked[];
};

export type BootstrapLine = { stream: "stdout" | "stderr"; line: string };

/** How a step ended. `code` is null when the shell was killed by a signal. */
export type BootstrapExit = { tool: BootstrapTool; need: BootstrapNeed; code: number | null };

/**
 * A step as it runs, or as it last ran. Held in main for the same reason verb
 * runs are (verb-run.ts): a window reopened mid-install rejoins it.
 */
export type BootstrapRun = {
  tool: BootstrapTool;
  need: BootstrapNeed;
  command: string;
  startedAt: string;
  lines: BootstrapLine[];
  exit?: BootstrapExit;
};

/** How many lines of a step main keeps. An installer prints a lot of progress. */
export const MAX_BOOTSTRAP_LINES = 500;
