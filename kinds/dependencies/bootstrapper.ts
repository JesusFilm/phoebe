// The bootstrapper pin (#832): the `ARG PHOEBE_AGENT_VERSION` line a
// deployment's Dockerfile carries. It moves in step with the engine ref in
// `phoebe.config.ts`, and `phoebe upgrade --both` moves the two together. A
// dependency bundle would move the pin alone, and merging it could break the
// deployment that merged it, so the detectors leave it out unless the tenant's
// `bootstrapperPin` option asks for it.

import type { Candidate } from "./candidate.ts";

/** The bootstrapper's npm name, as the Dockerfile installs it. */
export const BOOTSTRAPPER_PACKAGE = "phoebe-agent";

/** `skip` leaves the pin to `phoebe upgrade`; `propose` files it like any other dependency. */
export const BOOTSTRAPPER_PIN_MODES = ["skip", "propose"] as const;
export type BootstrapperPinMode = (typeof BOOTSTRAPPER_PIN_MODES)[number];

export const BOOTSTRAPPER_PIN_DEFAULT: BootstrapperPinMode = "skip";

// `Dockerfile`, `Dockerfile.prod`, `Containerfile`, `app.dockerfile`.
const CONTAINER_FILE_RE =
  /(?:^|\/)(?:(?:Dockerfile|Containerfile)(?:\.[^/]*)?|[^/]+\.(?:dockerfile|containerfile))$/i;

/**
 * Whether a candidate is the bootstrapper pinned in a container file. Which
 * source found it does not matter: Renovate names the manager `dockerfile`,
 * and the agent fallback names whatever it reads, so the manifest path counts
 * as much as the manager. A `phoebe-agent` in a `package.json` is an ordinary
 * dependency and stays in.
 */
export function isBootstrapperPin(candidate: Candidate): boolean {
  if (candidate.package !== BOOTSTRAPPER_PACKAGE) return false;
  return candidate.manager === "dockerfile" || CONTAINER_FILE_RE.test(candidate.workspace);
}

/** The candidates the mode keeps, and how many bootstrapper pins it set aside. */
export function withoutBootstrapperPin(
  candidates: readonly Candidate[],
  mode: BootstrapperPinMode,
): { kept: Candidate[]; skipped: number } {
  if (mode === "propose") return { kept: [...candidates], skipped: 0 };
  const kept = candidates.filter((c) => !isBootstrapperPin(c));
  return { kept, skipped: candidates.length - kept.length };
}
