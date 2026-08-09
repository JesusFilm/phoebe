// Hidden-HTML-comment watermark machinery shared across work kinds: a
// generic newest-wins scan (`parseLatestMarker`) plus the build/parse pairs
// for the three watermark shapes Phoebe embeds in PR/issue comments to avoid
// re-attempting a fix it already tried against unchanged state.

import { asSha, type Sha } from "./branded.ts";

/**
 * Scan comment bodies newest-first and return the first marker `parse` extracts,
 * or `null` when none match. Shared by every work kind's watermark lookup — the
 * latest marker wins when several exist on one PR.
 */
export function parseLatestMarker<T>(
  bodies: readonly string[],
  parse: (text: string) => T | null,
): T | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const parsed = parse(bodies[i]!);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export type ConflictFailWatermark = {
  prHead: Sha;
  mainHead: Sha;
};

const CONFLICT_FAIL_WATERMARK_RE =
  /<!--\s*phoebe-conflict-fail:\s*prHead=([0-9a-f]+)\s+mainHead=([0-9a-f]+)\s*-->/i;

export function buildConflictFailWatermarkMarker(watermark: ConflictFailWatermark): string {
  return `<!-- phoebe-conflict-fail: prHead=${watermark.prHead} mainHead=${watermark.mainHead} -->`;
}

export function parseConflictFailWatermark(text: string): ConflictFailWatermark | null {
  const match = CONFLICT_FAIL_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { prHead: asSha(match[1]!), mainHead: asSha(match[2]!) };
}

export type ChecksFailWatermark = {
  prHead: Sha;
};

const CHECKS_FAIL_WATERMARK_RE = /<!--\s*phoebe-checks-fail:\s*prHead=([0-9a-f]+)\s*-->/i;

export function buildChecksFailWatermarkMarker(watermark: ChecksFailWatermark): string {
  return `<!-- phoebe-checks-fail: prHead=${watermark.prHead} -->`;
}

export function parseChecksFailWatermark(text: string): ChecksFailWatermark | null {
  const match = CHECKS_FAIL_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { prHead: asSha(match[1]!) };
}

export type ReviewsHandledWatermark = {
  latest: string;
};

const REVIEWS_HANDLED_WATERMARK_RE = /<!--\s*phoebe-reviews-handled:\s*latest=([^\s>]+)\s*-->/i;

export function buildReviewsHandledMarker(watermark: ReviewsHandledWatermark): string {
  return `<!-- phoebe-reviews-handled: latest=${watermark.latest} -->`;
}

export function parseReviewsHandledWatermark(text: string): ReviewsHandledWatermark | null {
  const match = REVIEWS_HANDLED_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { latest: match[1]! };
}
