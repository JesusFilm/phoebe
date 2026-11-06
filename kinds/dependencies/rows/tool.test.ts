// Running a row's tool: stdout comes back whatever the exit code, a command
// that is not installed says so, and a failure with nothing on stdout carries
// stderr's last line.

import { tmpdir } from "node:os";
import { describe, expect, test } from "vite-plus/test";
import { createToolRunner } from "./tool.ts";

const run = createToolRunner({ env: process.env });

describe("createToolRunner", () => {
  test("returns stdout from a non-zero exit, as an audit that found something exits", async () => {
    const result = await run(
      process.execPath,
      ["-e", "process.stdout.write('{\"advisories\":{}}'); process.exit(1)"],
      tmpdir(),
    );
    expect(result).toEqual({ ok: true, code: 1, stdout: '{"advisories":{}}' });
  });

  test("reports a command that is not installed as missing", async () => {
    const result = await run("phoebe-no-such-tool", ["--version"], tmpdir());
    expect(result).toEqual({
      ok: false,
      missing: true,
      problem: "phoebe-no-such-tool is not installed",
    });
  });

  test("a failure with nothing on stdout carries stderr's last line", async () => {
    const result = await run(
      process.execPath,
      ["-e", "console.error('first'); console.error('ERR_PNPM_NO_LOCKFILE'); process.exit(2)"],
      tmpdir(),
    );
    expect(result).toEqual({
      ok: false,
      missing: false,
      problem: expect.stringMatching(/exited 2: ERR_PNPM_NO_LOCKFILE$/),
    });
  });

  test("turns off corepack's download prompt", async () => {
    const result = await run(
      process.execPath,
      ["-e", "process.stdout.write(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT)"],
      tmpdir(),
    );
    expect(result).toEqual({ ok: true, code: 0, stdout: "0" });
  });

  test("kills a run past its deadline", async () => {
    const quick = createToolRunner({ env: process.env, timeoutMs: 100 });
    const result = await quick(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], tmpdir());
    expect(result).toEqual({
      ok: false,
      missing: false,
      problem: expect.stringMatching(/killed by SIGTERM$/),
    });
  });
});
