// Workspace field reader (#83/#91): presence selects workspace mode; malformed
// values fail loudly; omitted depth defaults to 1. The explicit `tenants` arm
// (#128) is validated by the same shared validator the engine schema imports.

import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_WORKSPACE_DEPTH,
  ExplicitWorkspaceUnsupportedError,
  isExplicitWorkspace,
  readWorkspaceField,
  requireDepthArm,
  resolveWorkspace,
  validateWorkspaceField,
} from "./workspace-source.ts";

describe("readWorkspaceField", () => {
  test("absent workspace → null (ladder falls through to nested/flat)", () => {
    expect(readWorkspaceField({})).toBeNull();
    expect(readWorkspaceField({ engine: { source: "local" } })).toBeNull();
  });

  test("empty block defaults depth to 1", () => {
    expect(readWorkspaceField({ workspace: {} })).toEqual({ depth: DEFAULT_WORKSPACE_DEPTH });
    expect(DEFAULT_WORKSPACE_DEPTH).toBe(1);
  });

  test("honours an explicit depth", () => {
    expect(readWorkspaceField({ workspace: { depth: 3 } })).toEqual({ depth: 3 });
  });

  test("rejects depth < 1", () => {
    expect(() => readWorkspaceField({ workspace: { depth: 0 } })).toThrow(/workspace/);
    expect(() => readWorkspaceField({ workspace: { depth: -1 } })).toThrow(/workspace/);
  });

  test("rejects non-integer depth", () => {
    expect(() => readWorkspaceField({ workspace: { depth: 1.5 } })).toThrow(/workspace/);
  });

  test("rejects a non-object workspace value", () => {
    expect(() => readWorkspaceField({ workspace: true })).toThrow(/workspace/);
    expect(() => readWorkspaceField({ workspace: "yes" })).toThrow(/workspace/);
    expect(() => readWorkspaceField({ workspace: [] })).toThrow(/workspace/);
  });

  test("reads the explicit arm through the same entry point", () => {
    expect(readWorkspaceField({ workspace: { tenants: ["widget", "gadget"] } })).toEqual({
      tenants: ["widget", "gadget"],
    });
  });
});

describe("validateWorkspaceField — arm selection (#128)", () => {
  test("declaring both arms is an error", () => {
    expect(() => validateWorkspaceField({ depth: 1, tenants: ["widget"] })).toThrow(
      /exactly one of/i,
    );
  });

  test("an explicitly-undefined sibling is treated as absent, not as both arms", () => {
    expect(validateWorkspaceField({ depth: undefined, tenants: ["widget"] })).toEqual({
      tenants: ["widget"],
    });
    expect(validateWorkspaceField({ depth: 2, tenants: undefined })).toEqual({ depth: 2 });
  });

  test("isExplicitWorkspace narrows the union", () => {
    const walk = validateWorkspaceField({ depth: 2 });
    const explicit = validateWorkspaceField({ tenants: ["widget"] });
    expect(isExplicitWorkspace(walk)).toBe(false);
    expect(isExplicitWorkspace(explicit)).toBe(true);
    // Narrowing is what every caller needs — assert it type-checks, not just runs.
    expect(isExplicitWorkspace(explicit) ? explicit.tenants : []).toEqual(["widget"]);
  });
});

describe("validateWorkspaceField — the tenants list (#128)", () => {
  test("declared order is preserved verbatim (no sort)", () => {
    // Declared order is spawn/list/warn order — the explicit arm skips the slug
    // sort the depth walk ends with, so the validator must never reorder.
    expect(validateWorkspaceField({ tenants: ["zeta", "alpha", "mid"] })).toEqual({
      tenants: ["zeta", "alpha", "mid"],
    });
  });

  test("an empty list is a valid zero-tenant fleet", () => {
    expect(validateWorkspaceField({ tenants: [] })).toEqual({ tenants: [] });
  });

  test("rejects a non-array tenants value", () => {
    expect(() => validateWorkspaceField({ tenants: "widget" })).toThrow(/workspace\.tenants/);
    expect(() => validateWorkspaceField({ tenants: {} })).toThrow(/workspace\.tenants/);
  });

  test("rejects a non-string entry", () => {
    expect(() => validateWorkspaceField({ tenants: ["widget", 3] })).toThrow(/workspace\.tenants/);
    expect(() => validateWorkspaceField({ tenants: [{ dir: "widget" }] })).toThrow(
      /workspace\.tenants/,
    );
  });

  test("normalizes spelling without complaint", () => {
    expect(validateWorkspaceField({ tenants: ["./widget/", "apps/../web"] })).toEqual({
      tenants: ["widget", "web"],
    });
  });

  test("supports out-of-tree entries — absolute and `..` are deliberate", () => {
    expect(
      validateWorkspaceField({ tenants: ["widget", "/srv/legacy-api", "../sibling"] }),
    ).toEqual({ tenants: ["widget", "/srv/legacy-api", "../sibling"] });
  });

  test("rejects an entry that resolves to the workspace root itself", () => {
    for (const entry of ["", ".", "./", "apps/.."]) {
      expect(() => validateWorkspaceField({ tenants: [entry] })).toThrow(/root/i);
    }
  });

  test("rejects an entry that contains the workspace root", () => {
    // `../sibling` is a supported out-of-tree tenant; a bare `..` is the root's
    // own parent, so supervising it means a child whose tree holds the fleet
    // config — the same hazard as listing the root itself. Pure `..` chains are
    // ancestors whatever the root turns out to be, so this needs no root path.
    for (const entry of ["..", "../..", "./.."]) {
      expect(() => validateWorkspaceField({ tenants: [entry] })).toThrow(/contains the workspace/i);
    }
  });

  test("rejects the root spelled as an absolute path when the root is known", () => {
    const root = "/srv/deploy";
    expect(() => validateWorkspaceField({ tenants: [root] }, { root })).toThrow(/root/i);
    expect(() => validateWorkspaceField({ tenants: ["/srv/deploy/"] }, { root })).toThrow(/root/i);
    expect(() => validateWorkspaceField({ tenants: ["/srv"] }, { root })).toThrow(
      /contains the workspace/i,
    );
    // Same list, no root supplied: engine-side validation cannot see the clash.
    expect(validateWorkspaceField({ tenants: [root] })).toEqual({ tenants: [root] });
  });

  test("a known root leaves genuine out-of-tree entries alone", () => {
    const root = "/srv/deploy";
    expect(
      validateWorkspaceField({ tenants: ["widget", "/srv/legacy-api", "../sibling"] }, { root }),
    ).toEqual({ tenants: ["widget", "/srv/legacy-api", "../sibling"] });
  });

  test("rejects duplicates after normalization", () => {
    expect(() => validateWorkspaceField({ tenants: ["widget", "./widget/"] })).toThrow(
      /duplicate/i,
    );
  });

  test("a known root catches a relative entry duplicating an absolute one", () => {
    // Two spellings of one directory. Comparing the declared strings misses it;
    // comparing what they resolve to does not.
    const root = "/srv/deploy";
    expect(() =>
      validateWorkspaceField({ tenants: ["widget", "/srv/deploy/widget"] }, { root }),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateWorkspaceField({ tenants: ["apps", "/srv/deploy/apps/web"] }, { root }),
    ).toThrow(/nested/i);
  });

  test("rejects a tenant nested inside another tenant", () => {
    expect(() => validateWorkspaceField({ tenants: ["apps", "apps/web"] })).toThrow(/nested/i);
    // Order-independent: the outer dir listed second is the same clash.
    expect(() => validateWorkspaceField({ tenants: ["apps/web", "apps"] })).toThrow(/nested/i);
    // A filesystem-root entry is absurd but must still nest-check correctly —
    // naive `outer + sep` prefixing would compare against "//" and miss it.
    expect(() => validateWorkspaceField({ tenants: ["/", "/srv/x"] })).toThrow(/nested/i);
  });

  test("a shared name prefix is not nesting", () => {
    expect(validateWorkspaceField({ tenants: ["app", "app-web"] })).toEqual({
      tenants: ["app", "app-web"],
    });
  });

  test("rejects glob characters with a message that names the alternative", () => {
    for (const entry of ["apps/*", "apps/?eb", "apps/[ab]", "apps/{a,b}"]) {
      expect(() => validateWorkspaceField({ tenants: [entry] })).toThrow(/glob/i);
    }
  });
});

describe("requireDepthArm — declared fleets validate but do not yet discover", () => {
  test("passes the walk arm's depth straight through", () => {
    expect(requireDepthArm({ depth: 3 })).toBe(3);
  });

  test("refuses the explicit arm rather than silently walking the tree", () => {
    // The dangerous failure would be falling back to a walk: the operator asked
    // for a declared fleet and would get an emergent one without being told.
    expect(() => requireDepthArm({ tenants: ["widget"] })).toThrow(
      ExplicitWorkspaceUnsupportedError,
    );
    expect(() => requireDepthArm({ tenants: ["widget"] })).toThrow(/not supported/i);
  });
});

describe("resolveWorkspace", () => {
  test("is the shared entry point for a loaded root config", () => {
    expect(resolveWorkspace({ workspace: { depth: 2 } })).toEqual({ depth: 2 });
    expect(
      resolveWorkspace({ workspace: { tenants: ["widget"] } }, { root: "/srv/deploy" }),
    ).toEqual({ tenants: ["widget"] });
    expect(resolveWorkspace({})).toBeNull();
  });
});
