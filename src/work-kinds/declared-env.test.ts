// Declared keys (#425): what a kind may name, and what happens when the pipeline
// cannot read one. The cases that matter are the two refusals validation owes
// (a reserved key, an `agentEnv` its `requiredEnv` does not cover) and the two
// postures the presence check has — fatal at boot, silent-but-off when a kind
// is switched on later.

import { describe, expect, test } from "vite-plus/test";
import {
  assertDeclaredEnvPresent,
  declaredEnvKeys,
  missingDeclaredEnv,
  reservedEnvReason,
  validateDeclaredEnv,
  type DeclaringKind,
} from "./declared-env.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";

const PROVIDER_KEYS = ["CURSOR_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_KEY"];

function definition(declared: Partial<AnyWorkKindDefinition>): AnyWorkKindDefinition {
  return {
    name: "slack-intake",
    oneShotEligible: false,
    promptFile: "prompts/intake.md",
    workspace: "scratch",
    report: { noun: "message(s)", describe: (unit: { ref: string }) => unit.ref },
    fetch: () => Promise.resolve([]),
    select: () => ({ unit: null, skipped: [], total: 0 }),
    run: () => Promise.resolve(),
    ...declared,
  } as AnyWorkKindDefinition;
}

function kind(declared: Partial<AnyWorkKindDefinition>, name = "slack-intake"): DeclaringKind {
  return { name, definition: definition({ ...declared, name }) };
}

describe("reservedEnvReason", () => {
  test("names the engine's own keys, both namespaces, and every provider key", () => {
    for (const key of [
      "GH_TOKEN",
      "PHOEBE_GH_LOGIN",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "PHOEBE_POLL_INTERVAL_MS",
      "GH_APP_PRIVATE_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(reservedEnvReason(key, PROVIDER_KEYS)).not.toBeNull();
    }
  });

  test("an ordinary key is not reserved", () => {
    expect(reservedEnvReason("SLACK_BOT_TOKEN", PROVIDER_KEYS)).toBeNull();
  });

  test("a renamed provider key is reserved by its configured name, not its default", () => {
    expect(reservedEnvReason("MY_CLAUDE_KEY", ["MY_CLAUDE_KEY"])).not.toBeNull();
    expect(reservedEnvReason("ANTHROPIC_API_KEY", ["MY_CLAUDE_KEY"])).toBeNull();
  });
});

describe("validateDeclaredEnv", () => {
  test("accepts a declaration with an agentEnv its requiredEnv covers", () => {
    expect(() =>
      validateDeclaredEnv(
        definition({
          requiredEnv: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
          agentEnv: ["SLACK_BOT_TOKEN"],
        }),
        "workKinds.custom.slack-intake",
        PROVIDER_KEYS,
      ),
    ).not.toThrow();
  });

  test("refuses an agentEnv naming a reserved key", () => {
    expect(() =>
      validateDeclaredEnv(
        definition({ requiredEnv: ["GH_APP_PRIVATE_KEY"], agentEnv: ["GH_APP_PRIVATE_KEY"] }),
        "workKinds.custom.slack-intake",
        PROVIDER_KEYS,
      ),
    ).toThrow(/GH_APP_PRIVATE_KEY/);
  });

  test("refuses an agentEnv key absent from requiredEnv", () => {
    expect(() =>
      validateDeclaredEnv(
        definition({ requiredEnv: ["SLACK_BOT_TOKEN"], agentEnv: ["SLACK_APP_TOKEN"] }),
        "workKinds.custom.slack-intake",
        PROVIDER_KEYS,
      ),
    ).toThrow(/`agentEnv` names `SLACK_APP_TOKEN`, which its `requiredEnv` does not/);
  });

  test("refuses a requiredEnv that is not an array of key names", () => {
    expect(() =>
      validateDeclaredEnv(
        definition({ requiredEnv: "SLACK_BOT_TOKEN" as unknown as string[] }),
        "workKinds.custom.slack-intake",
        PROVIDER_KEYS,
      ),
    ).toThrow(/must be an array of env key names/);
  });

  test("a kind that declares nothing passes", () => {
    expect(() =>
      validateDeclaredEnv(definition({}), "built-in checks", PROVIDER_KEYS),
    ).not.toThrow();
  });
});

describe("declaredEnvKeys", () => {
  test("is the sorted union over the kinds given, deduped", () => {
    expect(
      declaredEnvKeys([
        kind({ requiredEnv: ["SLACK_BOT_TOKEN", "LINEAR_KEY"] }, "intake"),
        kind({ requiredEnv: ["SLACK_BOT_TOKEN"] }, "triage"),
        kind({}, "checks"),
      ]),
    ).toEqual(["LINEAR_KEY", "SLACK_BOT_TOKEN"]);
  });
});

describe("missingDeclaredEnv", () => {
  test("counts an absent key and a blank one alike", () => {
    expect(
      missingDeclaredEnv([kind({ requiredEnv: ["SLACK_BOT_TOKEN", "LINEAR_KEY"] })], {
        SLACK_BOT_TOKEN: "   ",
      }),
    ).toEqual([
      { kind: "slack-intake", key: "SLACK_BOT_TOKEN" },
      { kind: "slack-intake", key: "LINEAR_KEY" },
    ]);
  });

  test("a set key is not missing", () => {
    expect(
      missingDeclaredEnv([kind({ requiredEnv: ["SLACK_BOT_TOKEN"] })], {
        SLACK_BOT_TOKEN: "xoxb-1",
      }),
    ).toEqual([]);
  });
});

describe("assertDeclaredEnvPresent", () => {
  test("a blank declared key fails the pipeline, naming the kind and the key", () => {
    expect(() =>
      assertDeclaredEnvPresent({
        repoSlug: "acme/widget",
        pipeline: "intake",
        kinds: [kind({ requiredEnv: ["SLACK_BOT_TOKEN"] })],
        env: { SLACK_BOT_TOKEN: "" },
      }),
    ).toThrow(/slack-intake: SLACK_BOT_TOKEN/);
  });

  test("a pipeline whose kinds declare nothing boots", () => {
    expect(() =>
      assertDeclaredEnvPresent({
        repoSlug: "acme/widget",
        pipeline: "work",
        kinds: [kind({}, "checks"), kind({}, "reviews")],
        env: {},
      }),
    ).not.toThrow();
  });
});
