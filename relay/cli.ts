// `phoebe relay <subcommand>` — the relay's command surface (#506 §1).
//
// Three subcommands, and they run on different machines. `serve` is the relay
// process itself; `init` writes the container files an operator stands it up
// from; `leave` runs on a deployment host and deletes that deployment's key,
// which is why it takes no `--data-dir` and reads `PHOEBE_DATA_DIR` the way
// `phoebe doctor` does. The parser refuses an unknown subcommand by name rather
// than falling through to anything, so adding one is additive.

import { resolve as resolvePath } from "node:path";
import { relayLeave } from "../bootstrap/relay-leave.ts";
import { resolveDataBase } from "../src/paths.ts";
import { relayInitNextSteps, runRelayInit } from "./init.ts";
import { runRelayServe } from "./serve.ts";
import { formatInitReport } from "../src/init.ts";

export type ParsedRelayArgs = {
  help: boolean;
  subcommand: "serve" | "init" | "leave" | null;
  dataDir?: string;
  port?: number;
  targetDir?: string;
};

/** Flags `serve` owns; naming them with `init` is a typo worth a sentence. */
const SERVE_ONLY_FLAGS = ["--port", "--data-dir"] as const;

export const RELAY_HELP_TEXT = `phoebe relay — the self-hosted service deployments dial into

Usage:
  phoebe relay serve [--port <n>] [--data-dir <path>]
                        Serve the console and the deployment socket
  phoebe relay init [dir]
                        Scaffold relay/{Dockerfile,compose.yml,.env.example}
                        (default dir: the current one)
  phoebe relay leave    On a deployment host: delete this deployment's key so it
                        stops proving who it is. Also remove the \`relay\` block
                        from the root config, and forget it on the relay.

Options:
  --port <n>            Port to bind (default: 8787; TLS is Caddy's job)
  --data-dir <path>     The relay volume (default: /data/relay). \`serve\` only;
                        \`leave\` reads the deployment volume from PHOEBE_DATA_DIR
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
    if ((arg === "serve" || arg === "init" || arg === "leave") && parsed.subcommand === null) {
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
      "`phoebe relay` needs a subcommand: `serve`, `init` or `leave`. See `phoebe relay --help`.",
    );
  }
  if (parsed.subcommand === "leave") {
    relayLeave({ dataBase: resolveDataBase(process.env) });
    return;
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
