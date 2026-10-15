// Which pipeline a log line belongs to, read off the tag the engine puts on it.
//
// The container's stdout is one stream for the whole deployment (#73), and every
// line on it says where it came from (docs/operating.md, "Reading the logs"):
//
//   [phoebe] …                                   the bootstrapper
//   [phoebe:<owner>/<repo>:<pipeline>] …         one pipeline's engine
//   [phoebe:<owner>/<repo>:<pipeline>][<kind> <ref>] …   the same, on behalf of one unit
//   [<owner>/<repo>:<pipeline>:<command>] …      an agent's own output
//
// The console turns that into tabs: every pipeline seen is one, beside "all"
// and the bootstrapper, and a workspace child opened from the rail gets a tab
// for everything under its slug. Nothing here changes a line; the console shows
// them as they came, and a tab only chooses which.

/** Every line, whatever it says. */
export const ALL_CHANNEL = "all";

/** The bootstrapper's lines, and any line with no tag the console knows. */
export const BOOT_CHANNEL = "boot";

/**
 * What `phoebe` itself printed on this machine: the lines of the verb the
 * companion last ran on the install (`start`, `stop`, `upgrade`, `doctor`, a
 * config edit). Not the container's output, so it is no line in "all" and no
 * tag decides it; the console holds the run and this is its tab.
 */
export const CLI_CHANNEL = "cli";

const PIPELINE_TAG = /^\[phoebe:([^\]:]+):([^\]]+)\]/;
const AGENT_TAG = /^\[([^\]:]+\/[^\]:]+):([^\]]+)\]/;

/**
 * The channel a line belongs to: `<owner>/<repo>:<pipeline>` for an engine
 * line, `<owner>/<repo>:<pipeline>:<command>` for an agent's, `boot` for the
 * bootstrapper's and for anything untagged, which is the runtime's own noise.
 */
export function channelOf(line: string): string {
  const pipeline = PIPELINE_TAG.exec(line);
  if (pipeline !== null) return `${pipeline[1]}:${pipeline[2]}`;
  const agent = AGENT_TAG.exec(line);
  if (agent !== null) {
    // `[owner/repo:work:claude:stderr]` is the same channel as `[owner/repo:work:claude]`.
    const command = (agent[2] as string).replace(/:stderr$/, "");
    return `${agent[1]}:${command}`;
  }
  return BOOT_CHANNEL;
}

/** Every channel under one tenant: `<owner>/<repo>:*`. The tab a workspace child opens on. */
export function tenantChannel(slug: string): string {
  return `${slug}:*`;
}

/** Whether a channel is one tenant's whole set rather than one pipeline's. */
function isTenantChannel(channel: string): boolean {
  return channel.endsWith(":*");
}

/**
 * The tabs to draw for the channels seen: all, then boot, then cli when a verb
 * has run on the install, then the tenant scope when
 * there is one (there before its first line, so a child opened from the rail
 * has its tab from the start), then each channel in the order it first spoke.
 *
 * The channels are handed over rather than read back off the lines — logs.ts
 * collects them as they arrive — so the tabs cost no parse per render and a
 * channel keeps its tab for the session, through a clear and past the line
 * bound dropping everything it said.
 */
export function channelsIn(
  seen: ReadonlySet<string>,
  scope: string | null = null,
  cli = false,
): string[] {
  const ordered = [...seen].filter((channel) => channel !== BOOT_CHANNEL);
  return [
    ALL_CHANNEL,
    ...(seen.has(BOOT_CHANNEL) ? [BOOT_CHANNEL] : []),
    // The CLI's tab is there once a verb has run, beside the bootstrapper's:
    // the two that are about the deployment rather than about a pipeline.
    ...(cli ? [CLI_CHANNEL] : []),
    ...(scope === null ? [] : [scope]),
    ...ordered,
  ];
}

/**
 * Whether a line on channel `on` belongs under `channel` — the tab it would
 * show on, and the scope a clear covers it with. Every line belongs to `all`,
 * every line under a slug to that tenant's scope, and a pipeline's own lines to
 * its own tab. Which lines a tab actually draws is logs.ts's, because the marks
 * a clear leaves are part of the answer.
 */
export function inChannel(on: string, channel: string): boolean {
  if (channel === ALL_CHANNEL) return true;
  if (isTenantChannel(channel)) return on.startsWith(channel.slice(0, -1));
  return on === channel;
}

/**
 * What a tab is called. The repo without its owner, because every tab on one
 * console is one deployment's and the owner is the same on all of them; a
 * tenant's whole set is the repo alone; the bootstrapper by name.
 */
export function channelLabel(channel: string): string {
  if (channel === ALL_CHANNEL || channel === BOOT_CHANNEL || channel === CLI_CHANNEL) {
    return channel;
  }
  const bare = isTenantChannel(channel) ? channel.slice(0, -2) : channel;
  const slash = bare.indexOf("/");
  return slash === -1 ? bare : bare.slice(slash + 1);
}
