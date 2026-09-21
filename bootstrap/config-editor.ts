// The bootstrapper's end of `phoebe config set` (#536; decision #503).
//
// The deployment directory is bind-mounted `:ro` and the root `phoebe.config.ts`
// alone is mounted read-write, so the bootstrapper is the process that holds the
// pen. This module is that pen: one file, one writer, one ledger on the data
// volume, and a nudge into the reconcile loop it already runs.
//
// It owns three things the writer (src/config-edit.ts) deliberately does not.
//
// **Which file.** The root config, and nothing else. A workspace's tenant
// configs sit under the same `:ro` mount and are the operator's to edit in their
// own checkouts (#503, rule 3), so they are not reachable from here — not by
// policy check, but because this editor is built with one path and takes no
// other. An edit that meant a tenant is refused by the shape of the call.
//
// **Who validates.** The *materialized* checkout, spawned as
// `<entry> config set --validate <path> <value> --config <root>` — the same
// pattern that asks a checkout for a tenant's pipelines and its effective
// config. A deployment running an older engine therefore validates against the
// loader it is actually running, which is the only loader whose opinion matters.
// The engine is re-read per launch, so a relaunch onto a different commit moves
// the validator with it.
//
// **When the fleet finds out.** Immediately: the write breaks the poll's wait,
// so the drain starts on the edit rather than up to a reconcile interval later.
// The loop does not learn anything new from the nudge — it re-reads the config
// fingerprint and reconciles exactly as it would for a hand edit. The nudge only
// moves when.

import { readFileSync } from "node:fs";
import {
  applyConfigEdit,
  configEditLedgerPath,
  fingerprintOf,
  lastEditIdOf,
  liveLedger,
} from "../src/config-edit.ts";
import type { ConfigEdit, EditReceipt } from "../src/contracts/config-edit.ts";
import { diagnosis, engineCommandFor, lastJsonLine, type EngineCommand } from "./pipelines.ts";

/** The deployment's config-edit pen: apply an edit, and say which one last landed. */
export type ConfigEditor = {
  apply: (edit: ConfigEdit) => Promise<EditReceipt>;
  /** The newest applied edit still describing the file, for the report's reconcile section. */
  lastEditId: () => string | null;
  /** Point the validator at a freshly materialized checkout. */
  useEngine: (entry: string) => void;
  /** Break the reconcile poll's wait; set once the supervisor is running. */
  useNudge: (nudge: () => void) => void;
};

/** `{ ok }` as `phoebe config set --validate` prints it, read loosely. */
function readVerdict(payload: unknown): { ok: true } | { ok: false; reason: string } | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record["ok"] === true) return { ok: true };
  if (record["ok"] !== false) return null;
  const reason = record["reason"];
  return { ok: false, reason: typeof reason === "string" ? reason : "the config did not load" };
}

export function createConfigEditor(opts: {
  /** The root config's read-write mount — the one file this editor may write. */
  rootConfigPath: string;
  /** The data volume's mount point; the ledger lives under its `state/`. */
  dataBase: string;
  env?: NodeJS.ProcessEnv;
  /** Injected so a test asks neither a disk nor a spawn. */
  run?: EngineCommand;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  now?: () => number;
}): ConfigEditor {
  const read = opts.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const ledgerPath = configEditLedgerPath(opts.dataBase);
  let run: EngineCommand | null = opts.run ?? null;
  let nudge: (() => void) | null = null;

  return {
    useEngine(entry) {
      if (opts.run === undefined) run = engineCommandFor(entry);
    },
    useNudge(next) {
      nudge = next;
    },
    lastEditId() {
      let source: string;
      try {
        source = read(opts.rootConfigPath);
      } catch {
        return null;
      }
      let raw: string | null;
      try {
        raw = read(ledgerPath);
      } catch {
        raw = null;
      }
      return lastEditIdOf(liveLedger(raw, fingerprintOf(source)));
    },
    apply: async (edit) =>
      await applyConfigEdit(edit, {
        file: opts.rootConfigPath,
        ledgerPath,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.readFile !== undefined ? { readFile: opts.readFile } : {}),
        ...(opts.writeFile !== undefined ? { writeFile: opts.writeFile } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(nudge !== null ? { nudge } : {}),
        validate: async (candidate) => {
          const command = run;
          if (command === null) {
            return { ok: false, reason: "no engine is running to validate the change against" };
          }
          const result = command(
            [
              "config",
              "set",
              candidate.path,
              JSON.stringify(candidate.value),
              "--validate",
              "--config",
              opts.rootConfigPath,
            ],
            {},
          );
          // Exit 1 is the verdict "it does not load", printed as JSON — a
          // refusal to read, not a checkout that could not answer. Anything
          // whose last line is not a verdict is the second thing, and an engine
          // that cannot say whether a config loads is never a reason to write
          // one that might not.
          const verdict = readVerdict(lastJsonLine(result.stdout));
          return verdict ?? { ok: false, reason: diagnosis(result) };
        },
      }),
  };
}
