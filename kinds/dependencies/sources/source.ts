// What one dependency source hands the detector (ADR 0003). A source that
// fails is a log line and the other sources' results stand, so a source
// returns its failure rather than throwing it.

import type { Candidate } from "../candidate.ts";

export type SourceResult = { ok: true; candidates: Candidate[] } | { ok: false; problem: string };
