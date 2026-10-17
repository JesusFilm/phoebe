// What the two session verbs hand back (map #690): `phoebe pair` and
// `phoebe sessions`. Here rather than beside the verbs so a companion's
// install tab can render them without loading the Compose driver.

import type { RemoteScope, SessionRow } from "./remote-protocol.ts";

/**
 * A minted pairing code and the link built on it. The code is here and in no
 * other place a run writes: the shell printer puts it on stdout, the install
 * tab's "pair this companion" spends it without showing it, and every streamed
 * line says "code minted".
 */
export type PairOutcome = {
  /** `https://<node>.ts.net[:port]/pair#code=XXXX-XXXX-XXXX`. */
  url: string;
  /** `XXXX-XXXX-XXXX`, for typing into a companion. */
  code: string;
  /** ISO; five minutes from the mint. */
  expiresAt: string;
  scopes: RemoteScope[];
  deploymentId: string;
};

/** What `phoebe sessions` answers: the rows after the action, and how many went. */
export type SessionsOutcome = {
  sessions: SessionRow[];
  /** How many rows a revoke removed; zero for a list. */
  revoked: number;
  /** When the rows were read, so a renderer can say which are expired. */
  at: string;
};
