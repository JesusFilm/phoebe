// `phoebe relay <subcommand>` — the relay's command surface (#506 §1).
//
// Two subcommands, and they run on opposite machines. `serve` is the relay
// process itself; `leave` runs on a deployment host and deletes that
// deployment's key, which is why it takes no `--data-dir` and reads
// `PHOEBE_DATA_DIR` the way `phoebe doctor` does. `phoebe relay init` — the
// scaffolded Dockerfile, compose file and `.env.example` — is its own ticket;
// the parser refuses an unknown subcommand by name rather than falling through
// to anything, so adding it is additive.

import { relayLeave } from "../bootstrap/relay-leave.ts";
import { resolveDataBase } from "../src/paths.ts";
import { runRelayServe } from "./serve.ts";

export type ParsedRelayArgs = {
  help: boolean;
  subcommand: "serve" | "leave" | null;
  dataDir?: string;
  port?: number;
};

export const RELAY_HELP_TEXT = `phoebe relay — the self-hosted service deployments dial into

Usage:
  phoebe relay serve [--port <n>] [--data-dir <path>]
                        Serve the console and the deployment socket
  phoebe relay leave    On a deployment host: delete this deployment's key so it
                        stops proving who it is. Also remove the \`relay\` block
                        from the root config, and forget it on the relay.

Options:
  --port <n>            Port to bind (default: 8787; TLS is Caddy's job)
  --data-dir <path>     The relay volume (default: /data/relay). \`serve\` only;
                        \`leave\` reads the deployment volume from PHOEBE_DATA_DIR
  --help, -h            Show this message

Environment (the first four are required; see docs/relay.md):
  RELAY_HOST            Public hostname, e.g. relay.example.com
  GOOGLE_CLIENT_ID      Google "Web application" OAuth client id
  GOOGLE_CLIENT_SECRET  Its secret
  ALLOWED_EMAILS        Comma-separated addresses merged into the allowlist at
                        start. May be empty, which leaves the allowlist to the
                        first verified sign-in.
  RELAY_ALERT_WEBHOOK   Optional. Where one message per alert edge is POSTed.
                        Unset means nothing is posted; the relay still evaluates
                        every edge and still keeps alerts.json.
`;

export function parseRelayArgs(argv: readonly string[]): ParsedRelayArgs {
  const parsed: ParsedRelayArgs = { help: false, subcommand: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "serve" || arg === "leave") {
      parsed.subcommand = arg;
      continue;
    }
    if (arg === "--port" || arg === "--data-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`\`${arg}\` needs a value. See \`phoebe relay --help\`.`);
      }
      index += 1;
      if (arg === "--data-dir") {
        parsed.dataDir = value;
        continue;
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`\`--port ${value}\` is not a port number.`);
      }
      parsed.port = port;
      continue;
    }
    throw new Error(
      `Unknown argument \`${arg}\` for \`phoebe relay\`. See \`phoebe relay --help\`.`,
    );
  }
  // `--data-dir` and `--port` are the relay volume's and the relay's, and
  // `leave` runs nowhere near either. Accepting one silently would let an
  // operator believe they had pointed the verb at a deployment's volume when
  // they had not.
  if (
    parsed.subcommand === "leave" &&
    (parsed.dataDir !== undefined || parsed.port !== undefined)
  ) {
    throw new Error(
      "`phoebe relay leave` takes no options — it reads the deployment's own volume from " +
        "PHOEBE_DATA_DIR. See `phoebe relay --help`.",
    );
  }
  return parsed;
}

/** Entry point `src/cli.ts` reaches through a lazy import. */
export async function runRelayCli(argv: readonly string[]): Promise<void> {
  const parsed = parseRelayArgs(argv);
  if (parsed.help) {
    process.stdout.write(RELAY_HELP_TEXT);
    return;
  }
  if (parsed.subcommand === null) {
    throw new Error(
      "`phoebe relay` needs a subcommand: `serve` or `leave`. See `phoebe relay --help`.",
    );
  }
  if (parsed.subcommand === "leave") {
    relayLeave({ dataBase: resolveDataBase(process.env) });
    return;
  }
  await runRelayServe({
    env: process.env,
    ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
  });
}
