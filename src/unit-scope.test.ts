// Per-unit naming (#423): the encoding that turns a kind-owned ref into a
// directory and a lease owner. The properties that matter are safety (nothing a
// ref can say escapes its segment) and injectivity (two refs never land on one
// path), so most of this file is about refs a kind author would not think to
// write.

import { describe, expect, test } from "vite-plus/test";
import { encodeUnitRef, unitDir, unitOwner } from "./unit-scope.ts";

describe("encodeUnitRef", () => {
  test("leaves the portable filename set alone", () => {
    expect(encodeUnitRef("issue-88")).toBe("issue-88");
    expect(encodeUnitRef("v1.2.3_final")).toBe("v1.2.3_final");
  });

  test("percent-encodes the built-in convention's colon", () => {
    expect(encodeUnitRef("pr:123")).toBe("pr%3A123");
    expect(encodeUnitRef("issue:88")).toBe("issue%3A88");
  });

  // The two characters the acceptance names. `/` must not become a path
  // separator, and `%` must be encoded or the mapping is not injective.
  test("a ref carrying / and % round-trips to one flat segment", () => {
    expect(encodeUnitRef("feed/2026%mix")).toBe("feed%2F2026%25mix");
    expect(encodeUnitRef("feed/2026%mix")).not.toContain("/");
  });

  test("refs that differ only in their encodable characters stay distinct", () => {
    const refs = ["a/b", "a%2Fb", "a%252Fb", "a:b", "a b"];
    expect(new Set(refs.map(encodeUnitRef)).size).toBe(refs.length);
  });

  // A ref is a kind's own string and a kind is trusted as the tenant, but
  // trusted is not the same as careful: a ref built from a branch name or a
  // channel title should not be able to name a directory outside its own.
  test("nothing a ref can say climbs out of its segment", () => {
    expect(encodeUnitRef("../../etc/passwd")).toBe("..%2F..%2Fetc%2Fpasswd");
    expect(encodeUnitRef("a\nb")).toBe("a%0Ab");
    expect(encodeUnitRef("$(rm -rf /)")).toBe("%24%28rm%20-rf%20%2F%29");
  });

  test("non-ASCII becomes its UTF-8 encoding, so the segment is always ASCII", () => {
    expect(encodeUnitRef("ticket-é")).toBe("ticket-%C3%A9");
  });
});

describe("unitDir", () => {
  test("keeps the kind as its own segment and encodes only the ref", () => {
    expect(unitDir("/data/scratch", { kind: "research", id: "issue:9" })).toBe(
      "/data/scratch/research/issue%3A9",
    );
  });

  test("two units of one kind never share a directory", () => {
    const a = unitDir("/data/scratch", { kind: "research", id: "issue:9" });
    const b = unitDir("/data/scratch", { kind: "research", id: "issue:10" });
    expect(a).not.toBe(b);
  });
});

describe("unitOwner", () => {
  test("joins the row and the unit across the segment the boot break reads", () => {
    expect(unitOwner("work", { kind: "issues", id: "issue:88" })).toBe("work#issues:issue%3A88");
  });

  // The reason string is parsed back off a porcelain listing by splitting on
  // whitespace, so an owner that contained a space would truncate.
  test("an owner is whitespace-free whatever the ref said", () => {
    const owner = unitOwner("work", { kind: "slack", id: "thread 7 in #general" });
    expect(owner).not.toMatch(/\s/);
  });

  test("the kind is part of the identity, so two kinds on one ref differ", () => {
    expect(unitOwner("work", { kind: "issues", id: "issue:5" })).not.toBe(
      unitOwner("work", { kind: "research", id: "issue:5" }),
    );
  });
});
