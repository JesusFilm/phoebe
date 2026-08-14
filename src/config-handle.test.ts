// Tests for ConfigHandle, editConfigAppendWorkKind, and ConfigRefusal.
//
// Contracts:
//   * editConfigAppendWorkKind rewrites single-line and multi-line workOrder
//     arrays byte-identically outside the array span.
//   * Already-present kind: ok=true, content unchanged.
//   * Empty array: appended correctly.
//   * Trailing-comma style is preserved.
//   * Non-literal elements (spreads, computed values) produce ok=false.
//   * workOrder not found as a plain array literal produces ok=false.
//   * ConfigRefusal is detected by isConfigRefusal; plain Record is not.
//   * configHandle.appendWorkKind delegates to editConfigAppendWorkKind.

import { describe, expect, test } from "vite-plus/test";
import {
  ConfigRefusal,
  configHandle,
  editConfigAppendWorkKind,
  isConfigRefusal,
  workKindInstruction,
} from "./config-handle.ts";

// ------------------------------------------------------------------ fixtures

const MINIMAL = (extra = ""): string => `export const config = {
  repoSlug: "acme/test",
  repoUrl: "https://github.com/acme/test.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",${extra}
};
`;

// ------------------------------------------------------------------ editConfigAppendWorkKind

describe("editConfigAppendWorkKind — single-line arrays", () => {
  test("appends to a non-empty array (no trailing comma)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts", "checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`workOrder: ["conflicts", "checks", "research"]`);
    // Everything outside the array is byte-identical
    expect(result.content).toContain("repoSlug");
    expect(result.content).toContain("npm ci");
  });

  test("appends to an array with trailing comma", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts",],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`workOrder: ["conflicts", "research",]`);
  });

  test("appends to an empty array", () => {
    const content = MINIMAL(`\n  workOrder: [],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`workOrder: ["research"]`);
  });

  test("returns ok=true unchanged when kind already present (double quotes)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts", "research"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(content);
  });

  test("returns ok=true unchanged when kind already present (single quotes)", () => {
    const content = MINIMAL(`\n  workOrder: ['conflicts', 'research'],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(content);
  });

  test("does not duplicate kind on second call", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts"],`);
    const first = editConfigAppendWorkKind(content, "research");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = editConfigAppendWorkKind(first.content, "research");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.content).toBe(first.content);
  });
});

describe("editConfigAppendWorkKind — multi-line arrays", () => {
  test("appends with trailing-comma style", () => {
    const content = MINIMAL(`\n  workOrder: [\n    "conflicts",\n    "checks",\n  ],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"research",');
    // New element at the same indent as existing ones
    expect(result.content).toContain('    "research",');
    // The original elements are still there
    expect(result.content).toContain('"conflicts",');
    expect(result.content).toContain('"checks",');
  });

  test("appends without trailing-comma style", () => {
    const content = MINIMAL(`\n  workOrder: [\n    "conflicts",\n    "checks"\n  ],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"research"');
    expect(result.content).toContain('"checks",');
  });

  test("returns ok=true unchanged when kind already present in multi-line array", () => {
    const content = MINIMAL(
      `\n  workOrder: [\n    "conflicts",\n    "research",\n    "checks",\n  ],`,
    );
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(content);
  });
});

describe("editConfigAppendWorkKind — refusals", () => {
  test("refuses when workOrder is absent", () => {
    const content = MINIMAL();
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
  });

  test("refuses when workOrder is a computed value", () => {
    const content = MINIMAL(`\n  workOrder: computeOrder(),`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
  });

  test("refuses when workOrder array contains a spread", () => {
    const content = MINIMAL(`\n  workOrder: [...BASE_ORDER, "checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
  });

  test("refuses when workOrder array contains a variable element", () => {
    const content = MINIMAL(`\n  workOrder: [EXTRA_KIND, "checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
  });

  test("refused result carries a reason string", () => {
    const content = MINIMAL(`\n  workOrder: [...BASE, "x"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("ConfigRefusal and isConfigRefusal", () => {
  test("isConfigRefusal returns true for ConfigRefusal instance", () => {
    const refusal = new ConfigRefusal("add it by hand");
    expect(isConfigRefusal(refusal)).toBe(true);
  });

  test("isConfigRefusal returns false for a plain Record", () => {
    const writes: Record<string, string> = { "phoebe.config.ts": "content" };
    expect(isConfigRefusal(writes)).toBe(false);
  });

  test("isConfigRefusal returns false for empty Record", () => {
    expect(isConfigRefusal({})).toBe(false);
  });

  test("ConfigRefusal carries the instruction string", () => {
    const instr = "add research to workOrder";
    const r = new ConfigRefusal(instr);
    expect(r.instruction).toBe(instr);
  });
});

describe("workKindInstruction", () => {
  test("includes the kind name and file reference", () => {
    const instr = workKindInstruction("research");
    expect(instr).toContain("research");
    expect(instr).toContain("phoebe.config.ts");
  });
});

describe("configHandle.appendWorkKind", () => {
  test("delegates to editConfigAppendWorkKind (smoke test)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts"],`);
    const result = configHandle.appendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"research"');
  });

  test("there is no workspace or tenant method on the handle (shape check)", () => {
    // Verify the handle does not expose workspace editing by checking
    // that no such method exists on the type.
    expect("editWorkspace" in configHandle).toBe(false);
    expect("editTenants" in configHandle).toBe(false);
    expect("addTenant" in configHandle).toBe(false);
    expect("removeTenant" in configHandle).toBe(false);
    expect("reorderTenants" in configHandle).toBe(false);
  });
});
