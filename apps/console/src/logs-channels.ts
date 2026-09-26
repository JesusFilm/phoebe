// Which pipeline a log line belongs to, read off the tag the engine puts on it.
//
// The container's stdout is one stream for the whole deployment (#73), and every
// line on it says where it came from (docs/operating.md, "Reading the logs"):
//
//   [phoebe] …                                   the bootstrapper
//   [phoebe:<owner>/<repo>:<pipeline>] …         one pipeline's engine
//   [phoebe:<owner>/<repo>:<pipeline>][<kind> <ref>] …   the same, on behalf of one unit
//   [<owner>/<repo>:<command>] …                 an agent's own output
//
// The console turns that into tabs: every pipeline seen is one, beside "all"
// and the bootstrapper, and a workspace child opened from the rail gets a tab
// for everything under its slug. Nothing here changes a line; the console shows
// them as they came, and a tab only chooses which.

/** Every line, whatever it says. */
export const ALL_CHANNEL = "all";

/** The bootstrapper's lines, and any line with no tag the console knows. */
export const BOOT_CHANNEL = "boot";

const PIPELINE_TAG = /^\[phoebe:([^\]:]+):([^\]]+)\]/;
const AGENT_TAG = /^\[([^\]:]+\/[^\]:]+):([^\]]+)\]/;

/**
 * The channel a line belongs to: `<owner>/<repo>:<pipeline>` for an engine
 * line, `<owner>/<repo>:<command>` for an agent's, `boot` for the bootstrapper's
 * and for anything untagged, which is the runtime's own noise.
 */
export function channelOf(line: string): string {
  const pipeline = PIPELINE_TAG.exec(line);
  if (pipeline !== null) return `${pipeline[1]}:${pipeline[2]}`;
  const agent = AGENT_TAG.exec(line);
  if (agent !== null) {
    // `[owner/repo:claude:stderr]` is the same channel as `[owner/repo:claude]`.
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
 * The tabs to draw for these lines: all, then boot, then the tenant scope when
 * there is one (there before its first line, so a child opened from the rail
 * has its tab from the start), then each channel in the order it first spoke.
 */
export function channelsIn(lines: readonly string[], scope: string | null = null): string[] {
  const seen = new Set<string>();
  for (const line of lines) seen.add(channelOf(line));
  const ordered = [...seen].filter((channel) => channel !== BOOT_CHANNEL);
  return [
    ALL_CHANNEL,
    ...(seen.has(BOOT_CHANNEL) ? [BOOT_CHANNEL] : []),
    ...(scope === null ? [] : [scope]),
    ...ordered,
  ];
}

/** The lines a tab shows. */
export function linesIn(lines: readonly string[], channel: string): string[] {
  if (channel === ALL_CHANNEL) return [...lines];
  if (isTenantChannel(channel)) {
    const prefix = channel.slice(0, -1);
    return lines.filter((line) => channelOf(line).startsWith(prefix));
  }
  return lines.filter((line) => channelOf(line) === channel);
}

/**
 * What a tab is called. The repo without its owner, because every tab on one
 * console is one deployment's and the owner is the same on all of them; a
 * tenant's whole set is the repo alone; the bootstrapper by name.
 */
export function channelLabel(channel: string): string {
  if (channel === ALL_CHANNEL || channel === BOOT_CHANNEL) return channel;
  const bare = isTenantChannel(channel) ? channel.slice(0, -2) : channel;
  const slash = bare.indexOf("/");
  return slash === -1 ? bare : bare.slice(slash + 1);
}
