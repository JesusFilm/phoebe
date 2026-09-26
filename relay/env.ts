// The relay's whole configuration: four required environment variables and one
// optional fifth, read once at start (#506 §9, #515 §2). There is no
// `relay.config.ts` and there will not be one — the heartbeat interval, the
// dark threshold, the alert debounce and the pairing-token TTL are constants in
// the code, not knobs, because an operator who tunes them is making the fleet's
// timing disagree with the relay's.
//
// Two of the four are Google's client credentials and one is the public
// hostname, all three useless when blank. The fourth, ALLOWED_EMAILS, is
// meaningfully empty: blank means "nobody is seeded, the first verified login
// claims this relay" (#505 §6). So the rule is *present*, not *non-blank* — a
// scaffolded `.env` carrying `ALLOWED_EMAILS=` has answered the question.
//
// RELAY_ALERT_WEBHOOK is the fifth and the only optional one, because absence
// is how alerting's one channel is declined — the crash reporter's shape,
// where not configuring a target is the opt-out (#515 §2). Absent means **no
// webhook**, not no alerting: the relay evaluates every edge and keeps
// `alerts.json` regardless, and the SSE `alert` event is not configurable
// (#524 §1).

/** The four required variables, in the order the scaffolded `.env` lists them. */
export const RELAY_ENV_VARS = [
  "RELAY_HOST",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
] as const;

/** The fifth, optional one: where an alert is posted (#515 §2). */
export const RELAY_ALERT_WEBHOOK_VAR = "RELAY_ALERT_WEBHOOK";

/** The variables whose value carries information, so blank is as bad as absent. */
const MUST_NOT_BE_BLANK = new Set(["RELAY_HOST", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

export type RelayEnv = {
  /** Public hostname the console is reached at; the redirect URI is built from it. */
  host: string;
  /** Google Web-application OAuth client id. */
  clientId: string;
  /** Its secret. Never logged, never written to the volume. */
  clientSecret: string;
  /** Addresses merged into the allowlist at every start, lowercased and deduped. */
  allowedEmails: string[];
  /**
   * Where an alert is POSTed, or null for a relay that posts none. The URL is
   * the secret — there is no signing — so it is never logged (#515 §2).
   */
  alertWebhook: string | null;
};

/**
 * Thrown when the relay cannot start because its environment is incomplete.
 * Named so a caller can tell a misconfiguration from a crash, and so the
 * message can name every missing variable at once rather than making the
 * operator rediscover them one restart at a time.
 */
export class RelayEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `phoebe relay serve cannot start. Set ${missing.join(", ")}. ` +
        `All four of ${RELAY_ENV_VARS.join(", ")} are required; ALLOWED_EMAILS may be empty, which leaves the allowlist to the first verified login.`,
    );
    this.name = "RelayEnvError";
    this.missing = missing;
  }
}

/**
 * Read the environment out of `env`, or throw `RelayEnvError` naming every
 * required variable that is missing. `ALLOWED_EMAILS` is split on commas; blank
 * entries are dropped, addresses are lowercased (Google's `email` claim is not
 * case-normalised for us) and deduped, so `a@x.test, ,A@X.test` is one person.
 *
 * `RELAY_ALERT_WEBHOOK` can never be missing, only unset: it is the one
 * optional variable, and blank is the same as absent.
 */
export function readRelayEnv(env: NodeJS.ProcessEnv): RelayEnv {
  const missing = RELAY_ENV_VARS.filter((name) => {
    const value = env[name];
    if (value === undefined) return true;
    return MUST_NOT_BE_BLANK.has(name) && value.trim() === "";
  });
  if (missing.length > 0) throw new RelayEnvError(missing);

  return {
    host: env.RELAY_HOST!.trim(),
    clientId: env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    allowedEmails: parseAllowedEmails(env.ALLOWED_EMAILS!),
    alertWebhook: trimmedOrNull(env[RELAY_ALERT_WEBHOOK_VAR]),
  };
}

/** A variable an operator may leave blank to mean "no". */
function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** `a@x.test, b@y.test` → `["a@x.test", "b@y.test"]`; blank → `[]`. */
export function parseAllowedEmails(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const email = part.trim().toLowerCase();
    if (email !== "") seen.add(email);
  }
  return [...seen];
}

/**
 * Where Google sends the browser back. Google requires HTTPS and registers this
 * exact string, so it is derived from `RELAY_HOST` rather than guessed from a
 * request's `Host` header — a header an operator's proxy can rewrite and an
 * attacker can forge. Localhost is the one exemption Google grants to the HTTPS
 * rule, and it is the only way to run the flow on a laptop.
 */
export function redirectUri(host: string, callbackPath: string): string {
  return `${isLocalhost(host) ? "http" : "https"}://${host}${callbackPath}`;
}

function isLocalhost(host: string): boolean {
  const name = host.split(":")[0]!.toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}
