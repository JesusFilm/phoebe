// The `bench` kind's options block (#989), validated once at registration so a
// bad block fails the pipeline list rather than a run. Every option is
// catalogued (src/settings-catalogue.ts), so `PHOEBE_BENCH_<FIELD>` beats the
// file, as it does for any catalogued path.

import type { BenchJudge } from "../../src/contracts/bench.ts";
import { parseBenchJudge } from "../../src/bench-judge.ts";
import { PROVIDER_NAMES } from "../../src/config-schema.ts";
import { readSetting, settingAt, type Setting } from "../../src/settings-catalogue.ts";
import { fail, isRecord, onlyKeys } from "../dependencies/options.ts";

export type BenchKindOptions = {
  /** The suite file, relative to the deployment directory. Required. */
  suite: string;
  /** How many of the suite's fixtures a bench replays: the newest, by PR number. */
  maxFixtures: number;
  /** How many times each fixture and contender pair is replayed. */
  repeat: number;
  /** Off when `null`: no judge runs and the comment has no verdicts. */
  judge: BenchJudge | null;
};

export const BENCH_OPTION_DEFAULTS: Omit<BenchKindOptions, "suite"> = {
  maxFixtures: 10,
  repeat: 1,
  judge: null,
};

const OPTION_KEYS: readonly (keyof BenchKindOptions)[] = [
  "suite",
  "maxFixtures",
  "repeat",
  "judge",
];

const SUITE = settingAt("kinds.bench.suite");
const MAX_FIXTURES = settingAt("kinds.bench.maxFixtures");
const REPEAT = settingAt("kinds.bench.repeat");
const JUDGE_PROVIDER = settingAt("kinds.bench.judge.provider");
const JUDGE_MODEL = settingAt("kinds.bench.judge.model");

function positiveInteger(at: string, what: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(at, `${what} must be a positive integer — got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** An integer option: the env name when it is set, else the file, else the default. */
function integerOption(
  at: string,
  raw: Record<string, unknown>,
  key: "maxFixtures" | "repeat",
  setting: Setting,
  env: NodeJS.ProcessEnv,
): number {
  const read = readSetting(env, setting);
  if (read !== undefined) return positiveInteger(at, read.via, Number(read.value));
  if (raw[key] === undefined) return BENCH_OPTION_DEFAULTS[key];
  return positiveInteger(at, `\`${key}\``, raw[key]);
}

/** The judge: the file's, with either leaf replaced by its env name. Both or neither. */
function judgeOption(
  at: string,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): BenchJudge | null {
  const rawJudge = raw["judge"];
  if (rawJudge !== undefined) {
    if (!isRecord(rawJudge)) fail(at, "`judge` must be an object with `provider` and `model`.");
    onlyKeys(`${at}.judge`, rawJudge, ["provider", "model"]);
  }
  const file = isRecord(rawJudge) ? rawJudge : null;
  const provider = readSetting(env, JUDGE_PROVIDER);
  const model = readSetting(env, JUDGE_MODEL);
  if (provider !== undefined && !(PROVIDER_NAMES as readonly string[]).includes(provider.value)) {
    fail(
      at,
      `${provider.via} must be one of ${PROVIDER_NAMES.join(", ")} — got "${provider.value}".`,
    );
  }
  const merged = {
    provider: provider?.value ?? file?.["provider"],
    model: model?.value ?? file?.["model"],
  };
  if (merged.provider === undefined && merged.model === undefined) return null;
  if (merged.provider === undefined || merged.model === undefined) {
    fail(
      at,
      `the judge needs both a provider and a model, and only ` +
        `${merged.provider === undefined ? "a model" : "a provider"} is set ` +
        `(\`judge\`, ${JUDGE_PROVIDER.env}, ${JUDGE_MODEL.env}).`,
    );
  }
  return parseBenchJudge({ provider: merged.provider, model: merged.model }, (what) =>
    fail(at, what),
  );
}

/**
 * Validate the block a tenant declared, fill the defaults and apply the env
 * names. `at` is the config path the errors name. An unknown field is refused,
 * as every catalog kind refuses one, because a typo'd option would otherwise
 * sit inert while looking configured.
 */
export function resolveBenchOptions(
  raw: unknown,
  at: string,
  env: NodeJS.ProcessEnv,
): BenchKindOptions {
  const block = raw === undefined ? {} : raw;
  if (!isRecord(block)) fail(at, "the bench kind's options must be an object.");
  onlyKeys(at, block, OPTION_KEYS);
  const fromEnv = readSetting(env, SUITE);
  const suite = fromEnv?.value ?? block["suite"];
  if (typeof suite !== "string" || suite.trim() === "") {
    fail(
      at,
      `\`suite\` is required: the suite file in the deployment directory, e.g. ` +
        `"bench/suite.json" (or set ${SUITE.env}).`,
    );
  }
  return {
    suite: suite.trim(),
    maxFixtures: integerOption(at, block, "maxFixtures", MAX_FIXTURES, env),
    repeat: integerOption(at, block, "repeat", REPEAT, env),
    judge: judgeOption(at, block, env),
  };
}
