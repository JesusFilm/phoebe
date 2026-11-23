// What one dependency source hands the detector (ADR 0003). A source that
// fails is a log line and the other sources' results stand, so a source
// returns its failure rather than throwing it.

import type { Candidate } from "../candidate.ts";

export type SourceResult =
  | {
      ok: true;
      candidates: Candidate[];
      /**
       * Set when the source answered without seeing everything it reads: a
       * project that would not list, a failed audit, a registry that did not
       * answer. What it found stands. What it did not find proves nothing, so
       * a detector must not read a missing candidate as a fixed one.
       */
      partial?: true;
    }
  | { ok: false; problem: string };
