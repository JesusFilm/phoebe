// The **deployment id** (map #690, decided in #694): a random id minted once
// onto the data volume and never regenerated. It is the one thing a paired
// client keys a deployment on — the descriptor answers with it before a code is
// spent, the pair response carries it, and a companion that finds a different
// id behind a URL it holds a session for knows the volume was wiped or another
// deployment took the name (`replaced`). Not derived from anything: a name can
// be reused and a config can be copied, and the id must survive neither.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file, inside the deployment-level `state/` directory. */
export const DEPLOYMENT_ID_FILE = "deployment-id";

/** Crockford base32: digits and letters without I, L, O and U. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The id's shape: the prefix and 26 Crockford characters (130 bits). */
export const DEPLOYMENT_ID_RE = /^dep_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function deploymentIdPath(dataBase: string): string {
  return join(dataBase, "state", DEPLOYMENT_ID_FILE);
}

/** A fresh id. Rejection-sampled so every character is uniform over the alphabet. */
export function mintDeploymentId(random: (n: number) => Buffer = randomBytes): string {
  let out = "";
  while (out.length < 26) {
    for (const byte of random(32)) {
      // 32 letters divide 256 evenly, so a mask is exact and nothing is rejected;
      // the loop shape stays, for an alphabet that changes.
      out += CROCKFORD_ALPHABET[byte & 31];
      if (out.length === 26) break;
    }
  }
  return `dep_${out}`;
}

/**
 * The id on the volume, minted on first read. A file that exists but does not
 * hold an id is replaced — it is not an id anyone could have paired on — and
 * the write is atomic so a reader never sees half of one.
 */
export function readOrMintDeploymentId(
  dataBase: string,
  deps: { random?: (n: number) => Buffer } = {},
): string {
  const path = deploymentIdPath(dataBase);
  if (existsSync(path)) {
    const held = readFileSync(path, "utf8").trim();
    if (DEPLOYMENT_ID_RE.test(held)) return held;
  }
  const minted = mintDeploymentId(deps.random);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${DEPLOYMENT_ID_FILE}.tmp`);
  writeFileSync(tmp, `${minted}\n`);
  renameSync(tmp, path);
  return minted;
}
