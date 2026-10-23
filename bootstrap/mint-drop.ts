// The **mint drop** (map #690, decided in #695; recorded in
// docs/adr/0002-pairing-codes-are-minted-root-only-through-a-file-drop.md):
// the root-owned directory a pairing code's hash passes through on its way to
// the bootstrapper.
//
// Everything in the container runs as uid 10001 with one view of the
// filesystem, so a tenant child could write the config pen or the secret store
// if it chose to. What it must not be able to do is mint itself an outside
// credential: a 30-day `operate` session on another device. The gate is the
// one root-only path there is. `phoebe pair` runs as root, writes
// `{ nonce, hash, scopes, expiresAt }` here, and waits for the bootstrapper to
// acknowledge; uid 10001 can read the directory but cannot create, rename or
// replace anything in it, and the code itself only ever reaches the root
// process's stdout.
//
// The directory has to exist in the image, root-owned, on no volume: it cannot
// sit under `/var/run/phoebe`, the sidecar arm's uid 10001 tmpfs, and a volume
// or a `--tmpfs /run` over it would silently break minting — which is what the
// doctor `remote` check looks for.

import { statSync } from "node:fs";

/** Where the Dockerfile creates it. */
export const MINT_DROP_DIR = "/run/phoebe-mint";

/** What the doctor check reads about the drop. */
export type MintDropFacts = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  ownedByRoot: boolean;
};

/** Look at the drop. Injectable `stat` so a test never needs root. */
export function inspectMintDrop(
  stat: (path: string) => { isDirectory: () => boolean; uid: number } = statSync,
  path: string = MINT_DROP_DIR,
): MintDropFacts {
  try {
    const info = stat(path);
    return { path, exists: true, isDirectory: info.isDirectory(), ownedByRoot: info.uid === 0 };
  } catch {
    return { path, exists: false, isDirectory: false, ownedByRoot: false };
  }
}
