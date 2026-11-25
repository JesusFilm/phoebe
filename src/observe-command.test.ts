import { describe, expect, test } from "vite-plus/test";
import {
  observeExecArgv,
  parseObserveArgs,
  runObserveCli,
  runObserveInContainer,
} from "./observe-command.ts";

describe("parseObserveArgs", () => {
  test("takes --tenant and --lookback, spaced or inline", () => {
    expect(parseObserveArgs([])).toEqual({ help: false, tenant: null, lookback: null });
    expect(parseObserveArgs(["--tenant", "acme/widget", "--lookback=3d"])).toEqual({
      help: false,
      tenant: "acme/widget",
      lookback: "3d",
    });
    expect(parseObserveArgs(["--help"]).help).toBe(true);
  });

  test("refuses an unknown flag, a missing value and a lookback that is not a period", () => {
    expect(() => parseObserveArgs(["--every", "7d"])).toThrow(
      "Unknown flag `--every` for `phoebe observe`",
    );
    expect(() => parseObserveArgs(["acme/widget"])).toThrow("Unknown argument `acme/widget`");
    expect(() => parseObserveArgs(["--tenant"])).toThrow("`--tenant` needs a value");
    expect(() => parseObserveArgs(["--tenant", "--lookback", "3d"])).toThrow(
      "`--tenant` needs a value",
    );
    expect(() => parseObserveArgs(["--lookback", "two weeks"])).toThrow(
      '`--lookback` must be a period like 14d or 36h — got "two weeks".',
    );
  });
});

describe("observeExecArgv", () => {
  test("rebuilds the flags for the in-container run", () => {
    expect(observeExecArgv({ help: false, tenant: "acme/widget", lookback: "3d" })).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "observe",
      "--tenant=acme/widget",
      "--lookback=3d",
    ]);
    expect(observeExecArgv({ help: false, tenant: null, lookback: null })).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "observe",
    ]);
  });
});

describe("in the container", () => {
  const random = () => Buffer.from("0123456789ab");

  test("drops the ask and returns on the ack, pointing at the history", async () => {
    const asked: Array<{ nonce: string; content: string }> = [];
    const out: string[] = [];
    await runObserveCli(["--lookback", "3d"], {
      inContainer: true,
      random,
      ask: async (nonce, content) => {
        asked.push({ nonce, content });
        return { kind: "ok", detail: "observer run started for acme/widget (pipeline observe)." };
      },
      stdout: (text) => out.push(text),
    });
    expect(asked).toEqual([
      {
        nonce: random().toString("base64url"),
        content: JSON.stringify({ tenant: null, lookback: "3d" }),
      },
    ]);
    expect(out.join("")).toBe(
      "[phoebe] observer run started for acme/widget (pipeline observe).\n" +
        "[phoebe] Its record lands in `phoebe history --kind observer` when it settles.\n",
    );
  });

  test("a refusal is an error carrying the bootstrapper's reason", async () => {
    await expect(
      runObserveInContainer(
        { help: false, tenant: null, lookback: null },
        {
          random,
          ask: async () => ({
            kind: "refused",
            detail: "an observer run is already in flight for acme/widget.",
          }),
        },
      ),
    ).rejects.toThrow(
      "the observer run was refused: an observer run is already in flight for acme/widget.",
    );
  });

  test("no answer, or no drop to ask through, says the bootstrapper is not listening", async () => {
    const parsed = { help: false, tenant: null, lookback: null };
    await expect(
      runObserveInContainer(parsed, { random, ask: async () => ({ kind: "unanswered" }) }),
    ).rejects.toThrow("the bootstrapper did not answer within 10 s");
    await expect(
      runObserveInContainer(parsed, {
        random,
        ask: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        },
      }),
    ).rejects.toThrow("the bootstrapper did not answer within 10 s");
  });
});
