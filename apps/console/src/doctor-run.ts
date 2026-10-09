// **Run doctor**, as facts rather than markup (#546, decided in #507 §7 and §10).
//
// Two questions, and neither of them needs React to answer. May this deployment
// be asked at all, and what did the relay say came back — one deployment or
// fifty, in the same words either way.
//
// **The refusal is stated before the press, not after it.** A deployment the
// relay is not holding a socket for is refused `undelivered` the moment the ask
// reaches the relay (#506 §8), so the button is disabled with the reason
// already on screen. A console that let an operator press it and then reported
// the refusal would be dressing a fact it already knew as an outcome.
//
// **Nothing here reads a doctor report.** The words are about the ask — which
// run it belongs to — and what the run found arrives as the next report over
// the event stream, the way every other fact about a deployment does.

import { RELAY_DOCTOR_RUN, RELAY_UNDELIVERED } from "phoebe-agent/contracts";
import type { RelayDeploymentRow, RelayDoctorRunResult } from "phoebe-agent/contracts";
import { age } from "./facts.ts";

/**
 * Why this deployment cannot be asked to run doctor, or null when it can. One
 * sentence, in the relay's own words for where it holds the deployment: an
 * operator reading "dark 2 d" on the connection panel should read the same fact
 * here rather than a second vocabulary for it.
 */
export function whyNotAskable(row: RelayDeploymentRow, now: Date): string | null {
  switch (row.state) {
    case "connected":
      return null;
    case "disconnected":
      return `The relay is not holding this deployment's connection — it has been quiet for ${
        row.disconnectedForSeconds ?? 0
      } s. A request to it would come back undelivered.`;
    case "dark":
      return `This deployment has been dark${
        row.lastSeen === null ? "" : ` for ${age(row.lastSeen, now)}`
      }. A request to it would come back undelivered.`;
    case "unseen":
      return "This deployment has never connected. There is nothing to ask until it boots.";
  }
}

/**
 * One result as a sentence. The three words a deployment of this version can
 * answer with, plus the relay's own, and anything else read out verbatim — the
 * relay carries a receipt's word without policing it, so a deployment newer
 * than this console is quoted rather than mistranslated.
 */
export function outcomeLine(result: RelayDoctorRunResult): string {
  switch (result.outcome) {
    case RELAY_DOCTOR_RUN.started:
      return "a run started — the report will arrive when it finishes";
    case RELAY_DOCTOR_RUN.joined:
      return "joined the run already under way";
    case RELAY_DOCTOR_RUN.refused:
      return `refused${detailOf(result) === null ? "" : `: ${detailOf(result)}`}`;
    case RELAY_UNDELIVERED:
      return `undelivered — the relay holds no connection to it (${result.state})`;
    default:
      return detailOf(result) === null ? result.outcome : `${result.outcome}: ${detailOf(result)}`;
  }
}

/**
 * The fleet-wide press in one line: how many of each word came back. Counted,
 * not scored, and every deployment is still listed underneath — this is the
 * line an operator reads first, not the answer.
 */
export function fleetLine(results: RelayDoctorRunResult[]): string {
  if (results.length === 0) return "No deployment to ask: this relay holds no link yet.";
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  const counted = [...counts.entries()].map(([outcome, count]) => `${count} ${outcome}`);
  return `${results.length} asked — ${counted.join(", ")}.`;
}

/** A receipt's `detail`, when it is a sentence. The relay carries it unread. */
function detailOf(result: RelayDoctorRunResult): string | null {
  return typeof result.detail === "string" && result.detail.length > 0 ? result.detail : null;
}
