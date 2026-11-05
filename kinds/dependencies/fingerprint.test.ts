// The watermark: the bundle key holds across version moves, the fingerprint
// moves with the package-version set and the advisory set, and the marker
// round-trips through an issue body.

import { describe, expect, test } from "vite-plus/test";
import type { Candidate } from "./candidate.ts";
import { bundleKey, fingerprint, parseMarker, renderMarker } from "./fingerprint.ts";

function candidate(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.1.0",
    updateType: "minor",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

describe("bundleKey", () => {
  test("is the manager and the group", () => {
    expect(bundleKey({ manager: "npm", group: "relation:@mui" })).toBe("npm:relation:@mui");
  });
});

describe("fingerprint", () => {
  const bundle = { candidates: [candidate("react"), candidate("react-dom")] };

  test("is the first 12 hex characters of the sha256 over the sorted pairs and ids", () => {
    // sha256 of `[["react-dom@1.1.0","react@1.1.0"],[]]`, computed independently.
    expect(fingerprint(bundle)).toBe("51b3f14582dd");
  });

  test("ignores candidate order, workspaces and current versions", () => {
    expect(
      fingerprint({
        candidates: [
          candidate("react-dom", { current: "0.9.0" }),
          candidate("react", { workspace: "apps/web/package.json" }),
          candidate("react", { workspace: "apps/api/package.json" }),
        ],
      }),
    ).toBe(fingerprint(bundle));
  });

  test("moves when a target version moves", () => {
    expect(
      fingerprint({
        candidates: [candidate("react", { target: "1.1.1" }), candidate("react-dom")],
      }),
    ).not.toBe(fingerprint(bundle));
  });

  test("moves when a new advisory lands on an unchanged version", () => {
    const advised = candidate("react", {
      advisories: [{ id: "GHSA-aaaa-bbbb-cccc", severity: "low", fixedIn: "1.1.0" }],
    });
    expect(fingerprint({ candidates: [advised, candidate("react-dom")] })).not.toBe(
      fingerprint(bundle),
    );
  });
});

describe("marker", () => {
  test("round-trips through an issue body", () => {
    const marker = { key: "npm:workspace:apps/my app/package.json", fingerprint: "51b3f14582dd" };
    const body = `## Packages\n…\n\n${renderMarker(marker)}\n`;
    expect(parseMarker(body)).toEqual(marker);
  });

  test("renders as one HTML comment with no space in the key", () => {
    expect(renderMarker({ key: "npm:group:my types", fingerprint: "0123456789ab" })).toBe(
      "<!-- phoebe-dependencies bundle=npm%3Agroup%3Amy%20types fingerprint=0123456789ab -->",
    );
  });

  test("the last marker wins, so one planted earlier in the body decides nothing", () => {
    const real = { key: "npm:package:left-pad", fingerprint: "856f4dcce6b5" };
    const planted = renderMarker({ key: "npm:all", fingerprint: "000000000000" });
    expect(parseMarker(`- left-pad: ${planted}\n\n${renderMarker(real)}\n`)).toEqual(real);
  });

  test("no marker, no bundle", () => {
    expect(parseMarker("just prose mentioning phoebe-dependencies")).toBeNull();
    expect(parseMarker("<!-- phoebe-sentry group=4507123 -->")).toBeNull();
  });
});
