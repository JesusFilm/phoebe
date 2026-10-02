// Which leaves the console offers an edit on, and what it says about the rest
// (#503, #547).
//
// The interesting assertions are the refusals. A leaf offered where the
// deployment would refuse costs an operator a round trip; a leaf hidden where
// the deployment would have written costs them the feature and says nothing. So
// every arm of the closed set is named here, and the drift test below pins the
// table to the one the deployment refuses from.

import { describe, expect, test } from "vite-plus/test";
import { CLOSED_EDIT_BLOCKS } from "phoebe-agent/contracts";
import type { ConfigReport, EffectiveLeaf } from "phoebe-agent/contracts";
import {
  configSetCommand,
  editPanel,
  editProgress,
  fallbackPanel,
  leafEditability,
  manualEdit,
  readEditAnswer,
  readTypedValue,
} from "./config-edit.ts";
import { ago, report } from "./test-fixture.ts";

const ROOT: ConfigReport["root"] = {
  path: "/etc/phoebe/phoebe.config.ts",
  fingerprint: "sha256:9f2c1b7e",
};

function leaf(overrides: Partial<EffectiveLeaf> = {}): EffectiveLeaf {
  return { value: 2, source: "file", via: "phoebe.config.ts", reader: "engine", ...overrides };
}

function editability(
  path: string,
  overrides: Partial<EffectiveLeaf> = {},
  opts: { configPath?: string; root?: ConfigReport["root"] } = {},
) {
  return leafEditability({
    path,
    leaf: leaf(overrides),
    configPath: "configPath" in opts ? opts.configPath : ROOT.path,
    root: opts.root ?? ROOT,
  });
}

describe("which leaves carry an Edit", () => {
  test("a plain literal in the root config does", () => {
    expect(editability("pipelines.work.concurrency")).toEqual({ editable: true });
  });

  test("so does a leaf nothing has set yet — absent is insertable", () => {
    expect(
      editability("pipelines.work.pollIntervalMs", { value: null, source: "default" }),
    ).toEqual({ editable: true });
  });

  test("and one inherited from a shallower path, which is the path it would be written at", () => {
    expect(
      editability("pipelines.work.kinds.issues.model", {
        source: "inherited",
        via: "pipelines.work.model",
      }),
    ).toEqual({ editable: true });
  });
});

describe("and what the others say instead", () => {
  test("a tenant's own config is edited in its checkout, and the row says which file", () => {
    const closed = editability(
      "repoSlug",
      {},
      { configPath: "/etc/phoebe/children/web/phoebe.config.ts" },
    );
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.file).toBe("/etc/phoebe/children/web/phoebe.config.ts");
    expect(closed.why).toContain("tenant's own config");
  });

  test("a report that does not name the file behind a row says that, not 'not editable'", () => {
    const closed = editability("repoSlug", {}, { configPath: undefined });
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.why).toContain("does not name the file");
  });

  test("a root config the deployment could not read closes every leaf", () => {
    const closed = editability("repoSlug", {}, { root: { ...ROOT, fingerprint: null } });
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.why).toContain("could not read");
  });

  test.each([
    ["workspace.tenants", "fleet declaration"],
    ["engine.ref", "phoebe upgrade"],
    ["relay.url", "pairing"],
    ["deployment.start", "host's lifecycle"],
    ["paths.repos", "derived"],
    ["workKinds", "permanent alias"],
  ])("%s is closed, and the sentence says whose it is", (path, phrase) => {
    const closed = editability(path);
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.why).toContain(phrase);
  });

  test("a work kind's declaration is closed; a setting inside it is not", () => {
    const closed = editability("pipelines.work.kinds.issues");
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.why).toContain("declaration is code");
    expect(editability("pipelines.work.kinds.issues.model")).toEqual({ editable: true });
  });

  test("an opaque leaf is closed: a splice cannot see what it would replace", () => {
    const closed = editability("someBlock", { opaque: true, value: "a compose file" });
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.why).toContain("does not survive JSON");
  });

  test("a leaf env decides is closed, and names the variable that decides it", () => {
    const closed = editability("pipelines.work.concurrency", {
      source: "overlay",
      via: "PHOEBE_WORK_CONCURRENCY",
      from: "tenantEnv",
    });
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    expect(closed.why).toContain("PHOEBE_WORK_CONCURRENCY");
    expect(closed.why).toContain("env beats file");
  });

  test("a config-field alias is not env, so it stays editable", () => {
    // `workOrder` is a superseded *field* name, not a variable: it is a literal
    // in the file and a splice can move it.
    expect(editability("pipelines.work.workOrder", { source: "alias", via: "workOrder" })).toEqual({
      editable: true,
    });
  });

  test("the closed table is the deployment's own, not a copy of it", () => {
    // The refusals above read from `CLOSED_EDIT_BLOCKS` in contracts, which is
    // the table src/config-edit.ts refuses from. A console with its own copy
    // would start offering edits the day one side gained an entry.
    for (const block of CLOSED_EDIT_BLOCKS) {
      const closed = editability(`${block.prefix}.anything`);
      expect(closed.editable).toBe(false);
      if (closed.editable) continue;
      expect(closed.why).toBe(block.why);
    }
  });
});

describe("the fallback an operator can act on", () => {
  test("the manual edit is the nesting, not the dotted path", () => {
    expect(
      manualEdit({
        file: "/etc/phoebe/phoebe.config.ts",
        path: "pipelines.work.concurrency",
        value: 3,
      }),
    ).toBe(
      "In /etc/phoebe/phoebe.config.ts, write `pipelines: { work: { concurrency: 3 } }` by hand.",
    );
  });

  test("a key a shell would not accept as an identifier is quoted", () => {
    expect(manualEdit({ file: "c.ts", path: "kinds.stale-pr.model", value: "opus" })).toContain(
      'kinds: { "stale-pr": { model: "opus" } }',
    );
  });

  test("the command is the verb, with the file it is about", () => {
    expect(
      configSetCommand({
        file: "/etc/phoebe/phoebe.config.ts",
        path: "defaultProvider",
        value: "claude",
      }),
    ).toBe(`phoebe config set defaultProvider '"claude"' --config /etc/phoebe/phoebe.config.ts`);
  });

  test("a value with a space in it survives the paste", () => {
    const command = configSetCommand({ file: "c.ts", path: "model", value: "two words" });
    expect(command).toContain(`'"two words"'`);
  });
});

describe("reading what came back", () => {
  test("a written receipt is the written arm", () => {
    const answer = readEditAnswer({
      outcome: "written",
      receipt: { id: "e1", state: "written", file: "c.ts", path: "a", value: 1, at: ago(1) },
    });
    expect(answer.kind).toBe("written");
  });

  test("a refusal is the refused arm", () => {
    const answer = readEditAnswer({
      outcome: "refused",
      receipt: { id: "e1", state: "refused", reason: "stale", why: "it moved" },
    });
    expect(answer.kind).toBe("refused");
  });

  test("undelivered is the relay's, and carries no receipt", () => {
    expect(readEditAnswer({ outcome: "undelivered" })).toEqual({ kind: "undelivered" });
  });

  test("a word this console does not know is quoted, not guessed at", () => {
    expect(readEditAnswer({ outcome: "deferred", receipt: { state: "deferred" } })).toEqual({
      kind: "unknown",
      outcome: "deferred",
    });
  });

  test("an outcome with a receipt that is not one reads as the word alone", () => {
    expect(readEditAnswer({ outcome: "written", receipt: "yes" })).toEqual({
      kind: "unknown",
      outcome: "written",
    });
  });
});

describe("following a written edit into the report", () => {
  const withReconcile = (reconcile: Record<string, unknown>) =>
    report({
      bootstrapper: {
        ...report().bootstrapper,
        reconcile,
      } as never,
    });

  test("a fleet draining onto the new config is reconciling", () => {
    const state = editProgress(
      "e1",
      withReconcile({ phase: "reconciling", reason: "config", since: ago(2) }),
    );
    expect(state).toBe("reconciling");
  });

  test("idle with this edit's id is settled", () => {
    const state = editProgress(
      "e1",
      withReconcile({ phase: "idle", since: ago(2), lastEditId: "e1" }),
    );
    expect(state).toBe("settled");
  });

  test("idle with somebody else's edit is still waiting, not settled", () => {
    const state = editProgress(
      "e1",
      withReconcile({ phase: "idle", since: ago(2), lastEditId: "e0" }),
    );
    expect(state).toBe("waiting");
  });

  test("a report with no reconcile section is waiting, never a verdict", () => {
    expect(editProgress("e1", null)).toBe("waiting");
    expect(editProgress("e1", report({ bootstrapper: undefined as never }))).toBe("waiting");
  });
});

describe("the value an operator typed", () => {
  test.each([
    ["42", 42],
    ["true", true],
    ["null", null],
    ['"claude"', "claude"],
    ["claude", "claude"],
    ["v0.13.0", "v0.13.0"],
  ])("%s reads as the literal `phoebe config set` would give it", (text, expected) => {
    expect(readTypedValue(text)).toEqual({ ok: true, value: expected });
  });

  test("an object or a list is refused: a leaf holds one literal", () => {
    expect(readTypedValue('{"a":1}')).toEqual({ ok: false });
    expect(readTypedValue("[1,2]")).toEqual({ ok: false });
  });

  test("an empty box is the empty string, which is a value somebody chose", () => {
    expect(readTypedValue("  ")).toEqual({ ok: true, value: "" });
  });
});

describe("the panel under an edited row", () => {
  const idle = report({
    bootstrapper: {
      ...report().bootstrapper,
      reconcile: { phase: "idle", since: ago(2), lastEditId: "e1" },
    },
  });

  test("a write says where it landed, who for, and what the deployment did next", () => {
    const panel = editPanel({
      answer: {
        kind: "written",
        receipt: {
          id: "e1",
          state: "written",
          file: "/etc/phoebe/phoebe.config.ts",
          path: "pipelines.work.concurrency",
          value: 3,
          fingerprint: "sha256:after",
          at: ago(1),
          by: "ada@example.test",
        },
      },
      value: 3,
      path: "pipelines.work.concurrency",
      root: ROOT,
      report: idle,
      id: "e1",
    });
    expect(panel.tone).toBe("good");
    expect(panel.lead).toContain("/etc/phoebe/phoebe.config.ts");
    expect(panel.lead).toContain("ada@example.test");
    expect(panel.detail).toContain("reconciled onto this edit");
    // A write needs no fallback: the change is on disk.
    expect(panel.command).toBeUndefined();
  });

  test("a refusal quotes the deployment's own instruction, and adds the verb", () => {
    const panel = editPanel({
      answer: {
        kind: "refused",
        receipt: {
          id: "e1",
          state: "refused",
          file: "/etc/phoebe/phoebe.config.ts",
          path: "pipelines.work.concurrency",
          reason: "stale",
          why: "the config changed since you loaded it",
          instruction:
            "In /etc/phoebe/phoebe.config.ts, write `pipelines: { work: { concurrency: 3 } }` by hand.",
          at: ago(1),
        },
      },
      value: 3,
      path: "pipelines.work.concurrency",
      root: ROOT,
      report: idle,
      id: "e1",
    });
    expect(panel.tone).toBe("bad");
    expect(panel.lead).toContain("changed since you loaded it");
    expect(panel.detail).toContain("by hand");
    expect(panel.command).toContain("phoebe config set pipelines.work.concurrency 3");
  });

  test("undelivered carries the manual edit this console composed itself", () => {
    const panel = editPanel({
      answer: { kind: "undelivered" },
      value: "opus",
      path: "model",
      root: ROOT,
      report: idle,
      id: "e1",
    });
    expect(panel.lead).toContain("nothing was written");
    expect(panel.detail).toBe(`In ${ROOT.path}, write \`model: "opus"\` by hand.`);
    expect(panel.command).toContain(`phoebe config set model '"opus"'`);
  });

  test("a word this console does not know still leaves the operator able to act", () => {
    const panel = editPanel({
      answer: { kind: "unknown", outcome: "deferred" },
      value: 1,
      path: "a.b",
      root: ROOT,
      report: idle,
      id: "e1",
    });
    expect(panel.lead).toContain("deferred");
    expect(panel.detail).toContain("by hand");
    expect(panel.command).toContain("phoebe config set a.b 1");
  });
});

describe("the fallback on a closed leaf", () => {
  test("names the tenant's own file, not the root, when that is the one to edit", () => {
    const closed = editability(
      "repoSlug",
      {},
      { configPath: "/etc/phoebe/children/web/phoebe.config.ts" },
    );
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    const fallback = fallbackPanel({
      editability: closed,
      path: "repoSlug",
      value: "JesusFilm/web",
      root: ROOT,
    });
    expect(fallback.detail).toContain("/etc/phoebe/children/web/phoebe.config.ts");
    expect(fallback.command).toContain("--config /etc/phoebe/children/web/phoebe.config.ts");
  });

  test("falls back to the root config for a refusal with no other file in it", () => {
    const closed = editability("engine.ref");
    expect(closed.editable).toBe(false);
    if (closed.editable) return;
    const fallback = fallbackPanel({
      editability: closed,
      path: "engine.ref",
      value: "v1",
      root: ROOT,
    });
    expect(fallback.command).toContain(`--config ${ROOT.path}`);
  });
});
