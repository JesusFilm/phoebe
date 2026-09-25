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
// The drawer turns that into tabs: every pipeline seen is one, beside "all" and
// the bootstrapper. Nothing here changes a line; the drawer shows them as they
// came, and a tab only chooses which.

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

/** The tabs to draw for these lines: all, then each channel in the order it first spoke. */
export function channelsIn(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) seen.add(channelOf(line));
  const ordered = [...seen].filter((channel) => channel !== BOOT_CHANNEL);
  return [ALL_CHANNEL, ...(seen.has(BOOT_CHANNEL) ? [BOOT_CHANNEL] : []), ...ordered];
}

/** The lines a tab shows. */
export function linesIn(lines: readonly string[], channel: string): string[] {
  if (channel === ALL_CHANNEL) return [...lines];
  return lines.filter((line) => channelOf(line) === channel);
}

/**
 * What a tab is called. The repo without its owner, because every tab on one
 * drawer is one deployment's and the owner is the same on all of them; the
 * bootstrapper by name.
 */
export function channelLabel(channel: string): string {
  if (channel === ALL_CHANNEL || channel === BOOT_CHANNEL) return channel;
  const slash = channel.indexOf("/");
  return slash === -1 ? channel : channel.slice(slash + 1);
}
