// `phoebe relay <subcommand>` — the relay's command surface (#506 §1).
//
// Two subcommands: `serve` is the process, `init` writes the container files an
// operator stands it up from. `phoebe relay leave` is its own ticket; the
// parser refuses an unknown subcommand by name rather than falling through to
// anything, so adding it is additive.

import { resolve as resolvePath } from "node:path";
import { relayInitNextSteps, runRelayInit } from "./init.ts";
import { runRelayServe } from "./serve.ts";
import { formatInitReport } from "../src/init.ts";

export type ParsedRelayArgs = {
  help: boolean;
  subcommand: "serve" | "init" | null;
  dataDir?: string;
  port?: number;
  targetDir?: string;
};

/** Flags `serve` owns; naming them with `init` is a typo worth a sentence. */
const SERVE_ONLY_FLAGS = ["--port", "--data-dir"] as const;

export const RELAY_HELP_TEXT = `phoebe relay — the self-hosted service deployments dial into

Usage:
  phoebe relay serve [--port <n>] [--data-dir <path>]
                        Serve the console and (later) the deployment socket
  phoebe relay init [dir]
                        Scaffold relay/{Dockerfile,compose.yml,.env.example}
                        (default dir: the current one)

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
    if ((arg === "serve" || arg === "init") && parsed.subcommand === null) {
      parsed.subcommand = arg;
      continue;
    }
    if (parsed.subcommand === "init" && !arg.startsWith("-")) {
      if (parsed.targetDir !== undefined) {
        throw new Error(
          `\`phoebe relay init\` takes at most one directory (got \`${parsed.targetDir}\` and \`${arg}\`).`,
        );
      }
      parsed.targetDir = arg;
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
  if (parsed.subcommand === "init" && (parsed.port !== undefined || parsed.dataDir !== undefined)) {
    throw new Error(
      `${SERVE_ONLY_FLAGS.join(" and ")} configure \`phoebe relay serve\`, not \`phoebe relay init\` — ` +
        `the scaffolded compose file gives the relay both.`,
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
      "`phoebe relay` needs a subcommand — `serve` or `init`. See `phoebe relay --help`.",
    );
  }
  if (parsed.subcommand === "init") {
    const targetDir = resolvePath(parsed.targetDir ?? process.cwd());
    const report = runRelayInit({ targetDir });
    process.stdout.write(
      formatInitReport(report, targetDir, "relay init") + relayInitNextSteps(targetDir),
    );
    return;
  }
  await runRelayServe({
    env: process.env,
    ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
  });
}
