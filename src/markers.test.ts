import { describe, expect, test } from "vite-plus/test";
import { asSha } from "./branded.ts";
import {
  buildChecksFailWatermarkMarker,
  buildConflictFailWatermarkMarker,
  buildReviewsHandledMarker,
  parseChecksFailWatermark,
  parseConflictFailWatermark,
  parseLatestMarker,
  parseReviewsHandledWatermark,
} from "./markers.ts";

describe("conflict fail watermark", () => {
  const watermark = { prHead: asSha("abc123def"), mainHead: asSha("9876543210ab") };

  test("builds a parseable HTML comment marker", () => {
    const marker = buildConflictFailWatermarkMarker(watermark);
    expect(marker).toBe("<!-- phoebe-conflict-fail: prHead=abc123def mainHead=9876543210ab -->");
    expect(parseConflictFailWatermark(marker)).toEqual(watermark);
  });

  test("parseConflictFailWatermark returns null when marker absent", () => {
    expect(parseConflictFailWatermark("no marker here")).toBeNull();
  });

  test("parseLatestMarker returns latest conflict marker", () => {
    const older = buildConflictFailWatermarkMarker({
      prHead: asSha("old"),
      mainHead: asSha("oldmain"),
    });
    const newer = buildConflictFailWatermarkMarker(watermark);
    expect(
      parseLatestMarker(
        [`failure\n${older}`, "unrelated", `retry\n${newer}`],
        parseConflictFailWatermark,
      ),
    ).toEqual(watermark);
  });
});

describe("checks fail watermark", () => {
  const watermark = { prHead: asSha("abc123def") };

  test("builds a parseable HTML comment marker", () => {
    const marker = buildChecksFailWatermarkMarker(watermark);
    expect(marker).toBe("<!-- phoebe-checks-fail: prHead=abc123def -->");
    expect(parseChecksFailWatermark(marker)).toEqual(watermark);
  });

  test("parseLatestMarker returns latest checks marker", () => {
    const older = buildChecksFailWatermarkMarker({ prHead: asSha("old") });
    const newer = buildChecksFailWatermarkMarker(watermark);
    expect(
      parseLatestMarker(
        [`failure\n${older}`, "unrelated", `retry\n${newer}`],
        parseChecksFailWatermark,
      ),
    ).toEqual(watermark);
  });
});

describe("reviews handled watermark", () => {
  test("builds and parses timestamp marker", () => {
    const marker = buildReviewsHandledMarker({ latest: "2026-06-03T09:00:00Z" });
    expect(marker).toBe("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
    expect(parseReviewsHandledWatermark(marker)).toEqual({ latest: "2026-06-03T09:00:00Z" });
  });

  test("parseLatestMarker returns latest reviews marker", () => {
    const older = buildReviewsHandledMarker({ latest: "2026-06-01T00:00:00Z" });
    const newer = buildReviewsHandledMarker({ latest: "2026-06-03T00:00:00Z" });
    expect(
      parseLatestMarker(
        [`done\n${older}`, "unrelated", `retry\n${newer}`],
        parseReviewsHandledWatermark,
      ),
    ).toEqual({ latest: "2026-06-03T00:00:00Z" });
  });
});
