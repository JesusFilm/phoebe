// `phoebe list` — in-container, enumerate tenants + health (reads the
// status-v2 contract snapshot; #63/#95/#127/#141).

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import { resolveDataBase } from "../paths.ts";
import type { StatusSnapshot } from "../status-contract.ts";
import { workIdentityId } from "../status-contract.ts";
import {
  LIST_HELD_LEGEND,
  LIST_UNDECLARED_LEGEND,
  listTenants,
  type TenantListing,
} from "../tenant-commands.ts";
import type { Command } from "./types.ts";

const LIST_SPEC: ArgSpec = { booleanFlags: ["json", "check"] };

const QUEUE_LOOKAHEAD_LIMIT = 5;

/** `#12, #34→#12, #56` — each issue number, with its blockers when it has any. */
export function formatQueueLookahead(queue: TenantListing["queue"]): string {
  if (queue.length === 0) return "queue: (empty)";
  const shown = queue
    .slice(0, QUEUE_LOOKAHEAD_LIMIT)
    .map((entry) =>
      entry.blockedBy.length > 0
        ? `#${entry.issueNumber}→${entry.blockedBy.map((b) => `#${b}`).join(",")}`
        : `#${entry.issueNumber}`,
    )
    .join(", ");
  const rest = queue.length - QUEUE_LOOKAHEAD_LIMIT;
  return `queue: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * Render one tenant's engine state from its status-v2 lifecycle — a `stopped`,
 * `draining`, or `failed` tenant must read as such, not as `idle` (a silent
 * "no status" or "idle" reading here is indistinguishable from a tenant that
 * never booted, which is the case a mid-fleet-upgrade version mismatch costs
 * the most).
 */
function formatSnapshotState(snapshot: StatusSnapshot): string {
  const { state } = snapshot.lifecycle;
  if (state === "running" && snapshot.activeWork) {
    const work = snapshot.activeWork;
    return `working ${work.kind} #${workIdentityId(work) ?? work.workId}`;
  }
  if (state === "draining") return "draining";
  if (state === "stopped") return "stopped";
  if (state === "failed") return `failed — ${snapshot.lifecycle.reason ?? "unknown reason"}`;
  return "idle"; // starting / selecting / idle / running-with-no-activeWork
}

function formatTenantStatus(status: TenantListing["status"]): string {
  if (status === null) return "no status";
  if (!status.available) {
    if (status.reason === "unsupported-version") {
      return `status from a newer engine (${status.receivedVersion})`;
    }
    return status.reason === "not-found" ? "no status" : "unreadable status";
  }
  return formatSnapshotState(status.status);
}

function formatHealthDetail(listing: TenantListing): string {
  const flag = (label: string, on: boolean): string => `${on ? "✓" : "✗"} ${label}`;
  const state = formatTenantStatus(listing.status);
  return (
    `${flag("config", listing.configValid)}  ${flag("env", listing.envPresent)}  ` +
    `${flag("data", listing.retainedData)}  ${state}\n` +
    `      ${formatQueueLookahead(listing.queue)}`
  );
}

/** Held rows (#129) surface as `held — <reason>`, not a wall of ✗s. */
export function formatTenantListing(listing: TenantListing): string {
  const header =
    listing.slug !== null ? `  ${listing.path}  (${listing.slug})` : `  ${listing.path}`;
  if (listing.held) {
    const held = `held — ${listing.reason ?? "held"}`;
    const detail = listing.slug !== null ? `${held}  ${formatHealthDetail(listing)}` : held;
    return `${header}\n      ${detail}`;
  }
  return `${header}\n      ${formatHealthDetail(listing)}`;
}

export const listCommand: Command = {
  name: "list",
  summary: "phoebe list [--json] [--check]   List tenants + health (in-container)",
  help:
    "phoebe list — enumerate tenants + health\n\n" +
    "Usage: phoebe list [--json] [--check]\n\n" +
    "--check exits 1 when the declared fleet (workspace.tenants) has a held row.\n",
  async run(argv, ctx) {
    const { flags } = parseArgs(argv, LIST_SPEC);
    const result = await listTenants({
      configDir: ctx.cwd,
      dataBase: resolveDataBase(ctx.env),
    });

    const held = result.listings.some((listing) => listing.held);

    if (flags["json"] === true) {
      ctx.stdout.write(
        `${JSON.stringify({
          declared: result.declared,
          live: result.live,
          tenants: result.listings.map((listing) => ({
            path: listing.path,
            slug: listing.slug,
            held: listing.held,
            reason: listing.reason,
            configValid: listing.configValid,
            envPresent: listing.envPresent,
            retainedData: listing.retainedData,
            status: listing.status,
          })),
          undeclared: result.undeclared,
        })}\n`,
      );
      return flags["check"] === true && result.explicit && held ? 1 : 0;
    }

    if (result.listings.length === 0 && result.undeclared.length === 0) {
      ctx.stdout.write(
        "[phoebe] No tenants (solo single-tenant deployment, or a workspace with none declared yet).\n",
      );
      return 0;
    }

    const header =
      result.explicit && result.declared > 0
        ? `[phoebe] ${result.live} of ${result.declared} declared tenant(s):`
        : result.listings.length > 0
          ? `[phoebe] ${result.listings.length} tenant(s):`
          : "[phoebe] 0 declared tenant(s):";
    const body = result.listings.map(formatTenantListing).join("\n");
    const undeclaredSection =
      result.undeclared.length > 0
        ? `\n\nundeclared:\n${result.undeclared.map((path) => `  ${path}`).join("\n")}`
        : "";
    const legendParts: string[] = [];
    if (held) legendParts.push(LIST_HELD_LEGEND);
    if (result.undeclared.length > 0) legendParts.push(LIST_UNDECLARED_LEGEND);
    const legend = legendParts.length > 0 ? `\n${legendParts.join("\n")}` : "";
    const main = body.length > 0 ? `${header}\n${body}` : header;
    ctx.stdout.write(`${main}${undeclaredSection}${legend}\n`);

    return flags["check"] === true && result.explicit && held ? 1 : 0;
  },
};
