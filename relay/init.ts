// `phoebe relay init` — the relay's container files (#506 §1 and §2).
//
// The relay ships in `phoebe-agent` but its container does not: an operator
// stands it up from a consumer-owned `relay/{Dockerfile,compose.yml,.env.example}`
// that this command writes, in the style of `templates/container`. Setting
// `RELAY_HOST` and running `docker compose up -d --build` is then the whole
// deployment, TLS included — the compose file puts a Caddy sidecar in front of
// `phoebe relay serve` and keys its certificate on that name.
//
// The re-run contract is `phoebe init`'s, and it is the reason this is a
// scaffolder rather than a generator: a file that already exists is never
// touched, and the report says which ones it left alone. An operator who has
// edited the Dockerfile keeps their edit and reads that they kept it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  DEFAULT_TEMPLATE_PARAMS,
  mergeGitignore,
  readShippedFile,
  renderTemplate,
  type InitReport,
  type TemplateParams,
} from "../src/init.ts";

/** Where the scaffold lands, under whatever directory the operator names. */
export const RELAY_SCAFFOLD_DIR = "relay";

/** `.env` carries GOOGLE_CLIENT_SECRET, so it is gitignored on the way in. */
const RELAY_GITIGNORE_ENTRIES = [".env"] as const;

/**
 * One scaffolded file. A narrower shape than `phoebe init`'s: the relay has no
 * prompts to seed and no config to render consent into.
 */
export type RelayInitOutput = {
  destRelPath: string;
  source:
    | { kind: "template"; templateRelPath: string }
    | { kind: "gitignore"; entries: readonly string[] };
};

/** Every file `phoebe relay init` produces, in report order. */
export function planRelayInitOutputs(): RelayInitOutput[] {
  return [
    {
      destRelPath: `${RELAY_SCAFFOLD_DIR}/Dockerfile`,
      source: { kind: "template", templateRelPath: "relay/Dockerfile" },
    },
    {
      destRelPath: `${RELAY_SCAFFOLD_DIR}/compose.yml`,
      source: { kind: "template", templateRelPath: "relay/compose.yml" },
    },
    {
      destRelPath: `${RELAY_SCAFFOLD_DIR}/.env.example`,
      source: { kind: "template", templateRelPath: "relay/.env.example" },
    },
    {
      destRelPath: `${RELAY_SCAFFOLD_DIR}/.gitignore`,
      source: { kind: "gitignore", entries: RELAY_GITIGNORE_ENTRIES },
    },
  ];
}

export type RunRelayInitOptions = {
  /** The directory `relay/` is created under. Created if missing. */
  targetDir: string;
  /** Override template params (`cliBin`, `cliVersion`). */
  params?: Partial<TemplateParams>;
  /** Root for the shipped `templates/` tree (test seam). */
  packageRoot?: string;
};

/**
 * Write the scaffold and report what happened to each file. Existing files are
 * left exactly as they are; `.gitignore` is the one file merged into rather
 * than skipped, because appending a line is not overwriting anyone's work.
 */
export function runRelayInit(opts: RunRelayInitOptions): InitReport {
  const targetDir = resolvePath(opts.targetDir);
  const params: TemplateParams = { ...DEFAULT_TEMPLATE_PARAMS, ...opts.params };
  const report: InitReport = { created: [], updated: [], skipped: [] };

  mkdirSync(join(targetDir, RELAY_SCAFFOLD_DIR), { recursive: true });

  for (const output of planRelayInitOutputs()) {
    const destAbs = join(targetDir, output.destRelPath);
    mkdirSync(dirname(destAbs), { recursive: true });

    if (output.source.kind === "gitignore") {
      const existing = existsSync(destAbs) ? readFileSync(destAbs, "utf8") : "";
      const merged = mergeGitignore(existing, output.source.entries);
      if (merged === existing) {
        report.skipped.push(output.destRelPath);
      } else {
        writeFileSync(destAbs, merged);
        report[existing.length === 0 ? "created" : "updated"].push(output.destRelPath);
      }
      continue;
    }

    if (existsSync(destAbs)) {
      report.skipped.push(output.destRelPath);
      continue;
    }

    const template = readShippedFile(
      join("templates", output.source.templateRelPath),
      opts.packageRoot,
      import.meta.dirname,
    );
    writeFileSync(destAbs, renderTemplate(template, params));
    report.created.push(output.destRelPath);
  }

  return report;
}

/**
 * What to do next, printed under the file report. The order is load-bearing:
 * `RELAY_HOST` must already resolve to this host before the first `up`, or
 * Caddy asks Let's Encrypt for a certificate it cannot prove it should get.
 */
export function relayInitNextSteps(targetDir: string): string {
  return [
    "",
    `Next, in ${join(targetDir, RELAY_SCAFFOLD_DIR)}:`,
    "  1. cp .env.example .env, and fill in all four variables.",
    "  2. Create the Google OAuth client, with https://<RELAY_HOST>/auth/google/callback",
    "     as its one authorized redirect URI (docs/relay.md → Setting up the Google client).",
    "  3. Point RELAY_HOST at this host in DNS, with 80 and 443 reaching it — Caddy",
    "     cannot get a certificate for a name that does not answer.",
    "  4. docker compose up -d --build",
    "",
  ].join("\n");
}
