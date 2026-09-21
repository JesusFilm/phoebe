// The other half of the scheme the companion registers.
//
// `phoebe://console/…` is the renderer's own origin (console-scheme.ts);
// `phoebe://auth?code=…` is where the relay sends a completed sign-in (#523 §2).
// One scheme, two hosts, and the host is the whole of what tells them apart.
//
// The OS delivers that URL two ways and neither is a callback the app chose:
// macOS fires `open-url` on the running instance, and Windows and Linux launch
// a *second* process with the URL on its command line, which the single-instance
// lock in main.ts turns into a `second-instance` event. Both land here, so the
// parsing is in one place and main.ts only wires.
//
// Everything in this file returns null rather than throwing. A URL arriving from
// the OS is attacker-reachable — any program can ask the shell to open
// `phoebe://auth?code=whatever` — so a malformed one is a thing to ignore, and
// what stops a forged code is the PKCE verifier on the exchange, not this.

import { COMPANION_AUTH_URL } from "phoebe-agent/contracts";

/** The scheme and host `COMPANION_AUTH_URL` names, taken apart once. */
const AUTH = new URL(COMPANION_AUTH_URL);

/** The one-time code in an auth deep link, or null when the URL is not one. */
export function authCodeIn(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== AUTH.protocol || parsed.host !== AUTH.host) return null;
  const code = parsed.searchParams.get("code");
  return code === null || code === "" ? null : code;
}

/**
 * The code on a command line, or null. Windows and Linux hand the URL over as
 * an argument among the app's own, so every argument is tried and the first
 * that parses as an auth link wins.
 */
export function authCodeInArgv(argv: readonly string[]): string | null {
  for (const argument of argv) {
    const code = authCodeIn(argument);
    if (code !== null) return code;
  }
  return null;
}
