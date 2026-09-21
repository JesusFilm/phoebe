// Server-sent events, read by hand.
//
// The renderer gets `EventSource` from Chromium; main does not, and main is
// where the device token lives, so main is what holds the relay's stream open
// (#523 §1). What it needs off the wire is small — the relay writes one `event:`
// line and one `data:` line per frame plus a `:` comment on the heartbeat — so
// this is a parser for that, not an implementation of the spec's retry and
// last-event-id machinery, neither of which the relay uses.
//
// Split out from relay-session.ts because framing is the part worth testing on
// its own: a chunk boundary in the middle of a line is the bug this file exists
// to not have.

/** One frame off the stream: the `event:` name and the `data:` payload. */
export type SseFrame = { name: string; data: string };

/**
 * A feeder. Push decoded text in as it arrives, in whatever pieces it arrives
 * in; whole frames come out the far side. A frame with no `data:` line is
 * dropped, which is what a bare heartbeat comment is.
 */
export function createSseReader(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffered = "";
  let name = "message";
  const data: string[] = [];

  function dispatch(): void {
    if (data.length > 0) onFrame({ name, data: data.join("\n") });
    name = "message";
    data.length = 0;
  }

  function line(raw: string): void {
    // A blank line ends the frame; a leading colon is a comment, which is how
    // the relay proves an idle stream is still alive.
    if (raw === "") return dispatch();
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    // One optional space after the colon belongs to the framing, not the value.
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }

  return (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      // `\r\n` and a bare `\r` are both legal line endings in the spec; trimming
      // the carriage return here is the whole of handling them.
      const raw = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      line(raw);
      newline = buffered.indexOf("\n");
    }
  };
}
