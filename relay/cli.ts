// `phoebe relay <subcommand>` — the relay's command surface (#506 §1).
//
// One subcommand today, `serve`. `phoebe relay init` (the scaffolded
// Dockerfile, compose file and `.env.example`) and `phoebe relay leave` are
// their own tickets; the parser refuses an unknown subcommand by name rather
// than falling through to anything, so adding them is additive.

import { runRelayServe } from "./serve.ts";

export type ParsedRelayArgs = {
  help: boolean;
  subcommand: "serve" | null;
  dataDir?: string;
  port?: number;
};

export const RELAY_HELP_TEXT = `phoebe relay — the self-hosted service deployments dial into

Usage:
  phoebe relay serve [--port <n>] [--data-dir <path>]
                        Serve the console and (later) the deployment socket

Options:
  --port <n>            Port to bind (default: 8787; TLS is Caddy's job)
  --data-dir <path>     The relay volume (default: /data/relay)
  --help, -h            Show this message

Environment (all four required; see docs/relay.md):
  RELAY_HOST            Public hostname, e.g. relay.example.com
  GOOGLE_CLIENT_ID      Google "Web application" OAuth client id
  GOOGLE_CLIENT_SECRET  Its secret
  ALLOWED_EMAILS        Comma-separated addresses merged into the allowlist at
                        start. May be empty, which leaves the allowlist to the
                        first verified sign-in.
`;

export function parseRelayArgs(argv: readonly string[]): ParsedRelayArgs {
  const parsed: ParsedRelayArgs = { help: false, subcommand: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "serve") {
      parsed.subcommand = "serve";
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
      "`phoebe relay` needs a subcommand. The one that exists is `serve`. See `phoebe relay --help`.",
    );
  }
  await runRelayServe({
    env: process.env,
    ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
  });
}
