// What a log line must not carry off the deployment (map #690).
//
// The container's output is read two ways. On this machine it comes off Docker
// into the companion, and it is shown as printed: whoever can run `docker
// compose logs` here can read it anyway. Over the API it leaves the machine
// for a paired device, and a paired device holds a bearer, not the
// deployment's secrets — so every line is run through this before `GET
// /api/logs` sends it.
//
// Two kinds of knowledge. **Values the bootstrapper has held**: the deployment
// env it started with, every tenant's `.env` and secret store as it assembled a
// child's env, the tokens it minted. Each is learned under a key that names a
// secret and replaced wherever it appears, however it got into a line — an
// agent echoing its env, a URL with a token in it, an error message quoting a
// header. **Shapes**: the well-known token prefixes, so a value this process
// never held (one a child read from its own files) is still caught on sight.
//
// What is deliberately not caught: anything long and base64-looking. A git
// SHA is forty characters of `[0-9a-f]`, and a rule wide enough to catch an
// unknown key would blank every commit in the log. The shapes are the known
// prefixes, and the rest is the learned values.

export const REDACTED = "[redacted]";

/** A key that names a secret: the env var names a store or an `.env` uses for one. */
export const SECRET_KEY = /TOKEN|SECRET|PASSW|PRIVATE|API_?KEY|CREDENTIAL|AUTH|_KEY$|^KEY$/i;

/** A learned value shorter than this is not worth matching: it would blank prose. */
export const MIN_SECRET_LENGTH = 8;

/** The shapes caught on sight, learned or not. */
const SHAPES: readonly RegExp[] = [
  // GitHub: classic, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Anthropic and OpenAI keys share the prefix.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Tailscale auth and API keys.
  /\btskey-[A-Za-z0-9-]{10,}\b/g,
  // Slack.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // A JWT: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** `Bearer <token>` and `Authorization: <scheme> <token>`: the scheme stays, the token goes. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
const AUTHORIZATION = /\b([Aa]uthorization:\s*(?:[A-Za-z]+\s+)?)[A-Za-z0-9._~+/=-]{8,}/g;

/** `SOME_TOKEN=value` printed outright: the key stays, the value goes. */
const ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSW(?:OR)?D|PRIVATE_KEY|API_?KEY|CREDENTIALS?)[A-Z0-9_]*=)(["']?)[^\s"']+\2/g;

export type Redactor = {
  /** Learn every value of `env` whose key names a secret. */
  learnEnv: (env: Readonly<Record<string, string | undefined>>) => void;
  /** Learn values outright: a store's, a minted token. */
  learn: (values: Iterable<string | undefined | null>) => void;
  /** One line, with everything learned and every shape replaced. */
  redact: (line: string) => string;
  /** How many values are learned, for a test and a log line. */
  size: () => number;
};

export function createRedactor(): Redactor {
  const known = new Set<string>();
  let compiled: RegExp | null = null;
  let dirty = false;

  const add = (value: string): void => {
    // A multi-line value — a PEM key — is learned line by line as well as
    // whole: a child prints it a line at a time, and a line is what is matched.
    for (const piece of [value, ...value.split(/\r?\n/)]) {
      const trimmed = piece.trim();
      if (trimmed.length < MIN_SECRET_LENGTH) continue;
      if (!known.has(trimmed)) {
        known.add(trimmed);
        dirty = true;
      }
    }
  };

  const pattern = (): RegExp | null => {
    if (dirty || compiled === null) {
      dirty = false;
      if (known.size === 0) {
        compiled = null;
      } else {
        // Longest first, so a value that contains another is replaced whole.
        const sorted = [...known].sort((a, b) => b.length - a.length);
        compiled = new RegExp(sorted.map(escape).join("|"), "g");
      }
    }
    return compiled;
  };

  return {
    learnEnv(env) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string" && SECRET_KEY.test(key)) add(value);
      }
    },
    learn(values) {
      for (const value of values) if (typeof value === "string") add(value);
    },
    redact(line) {
      let out = line;
      const learned = pattern();
      if (learned !== null) out = out.replace(learned, REDACTED);
      for (const shape of SHAPES) out = out.replace(shape, REDACTED);
      out = out.replace(BEARER, `$1${REDACTED}`);
      out = out.replace(AUTHORIZATION, `$1${REDACTED}`);
      out = out.replace(ASSIGNMENT, `$1${REDACTED}`);
      return out;
    },
    size: () => known.size,
  };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
