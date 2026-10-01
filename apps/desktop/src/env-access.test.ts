import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import {
  accessOf,
  CONTAINER_UID,
  grantEnvAccess,
  probeEnvAccess,
  tenantEnvPath,
} from "./env-access.ts";

/** A runner that answers with `stdout` and remembers what it was asked. */
function runner(stdout: string) {
  const asked: { file: string; args: readonly string[] }[] = [];
  const run: CommandRunner = (spec) => {
    asked.push({ file: spec.file, args: spec.args });
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  return { run, asked };
}

describe("where a tenant's .env is", () => {
  test("beside its config, unless the config names a folder for it", () => {
    expect(tenantEnvPath("/w/a", 'export default { repoSlug: "acme/a" };\n')).toBe(
      path.join("/w/a", ".env"),
    );
    expect(tenantEnvPath("/w/a", 'export default { configDir: ".phoebe" };\n')).toBe(
      path.join("/w/a", ".phoebe", ".env"),
    );
    // No config to read is no folder named.
    expect(tenantEnvPath("/w/a", null)).toBe(path.join("/w/a", ".env"));
  });
});

describe("whether the container's user can read a file", () => {
  test("a file that is its owner's alone is not readable", () => {
    expect(accessOf("0|1000 1000 600|0")).toBe("unreadable");
    expect(accessOf("0|1000 1000 640|0")).toBe("unreadable");
  });

  test("readable by everyone, by the container's own user or group, or by an ACL entry", () => {
    expect(accessOf("0|1000 1000 644|0")).toBe("readable");
    expect(accessOf(`0|${CONTAINER_UID} 1000 600|0`)).toBe("readable");
    expect(accessOf(`0|1000 ${CONTAINER_UID} 640|0`)).toBe("readable");
    expect(accessOf("0|1000 1000 600|1")).toBe("readable");
  });

  test("a file that is not there is missing, and a line that says nothing is no answer", () => {
    expect(accessOf("3|missing")).toBe("missing");
    expect(accessOf("garbage")).toBeNull();
    expect(accessOf("0|1000 1000|0")).toBeNull();
  });
});

describe("asking about a workspace's tenants", () => {
  const WSL = "\\\\wsl.localhost\\archlinux\\home\\mike\\development";
  const files = [`${WSL}\\phoebe\\.phoebe\\.env`, `${WSL}\\youtube-studio\\.phoebe\\.env`];

  test("a WSL install is asked inside its distro, every file in one child", async () => {
    const { run, asked } = runner("0|1000 1000 600|1\n1|1000 1000 600|0\n");

    const answers = await probeEnvAccess(WSL, files, { runner: run, platform: "win32" });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.file).toBe("wsl.exe");
    expect(asked[0]!.args.slice(0, 4)).toEqual(["-d", "archlinux", "--exec", "sh"]);
    // The files go in as the distro knows them.
    expect(asked[0]!.args).toContain("/home/mike/development/youtube-studio/.phoebe/.env");
    expect(answers.get(files[0]!)).toBe("readable");
    expect(answers.get(files[1]!)).toBe("unreadable");
  });

  test("a folder on Windows's own disk has no permissions to ask about", async () => {
    const { run, asked } = runner("");

    const answers = await probeEnvAccess("C:\\repos\\ws", ["C:\\repos\\ws\\a\\.env"], {
      runner: run,
      platform: "win32",
    });

    expect(asked).toEqual([]);
    expect(answers.size).toBe(0);
  });

  test("a Linux host is asked directly", async () => {
    const { run, asked } = runner("0|missing\n");

    const answers = await probeEnvAccess("/repos/ws", ["/repos/ws/a/.env"], {
      runner: run,
      platform: "linux",
    });

    expect(asked[0]!.file).toBe("sh");
    expect(answers.get("/repos/ws/a/.env")).toBe("missing");
  });

  test("a probe that could not run says nothing, rather than that something is wrong", async () => {
    const failing: CommandRunner = () => Promise.reject(new Error("no such distro"));

    expect((await probeEnvAccess(WSL, files, { runner: failing, platform: "win32" })).size).toBe(0);
  });
});

describe("letting the container read one", () => {
  const WSL = "\\\\wsl.localhost\\archlinux\\home\\mike\\development";

  test("says which way access was given", async () => {
    const acl = runner("acl\n");
    expect(
      await grantEnvAccess(WSL, `${WSL}\\a\\.env`, { runner: acl.run, platform: "win32" }),
    ).toBe("acl");
    // The grant names the container's user and the one file.
    expect(acl.asked[0]!.args.join(" ")).toContain(`u:${CONTAINER_UID}:r`);
    expect(acl.asked[0]!.args).toContain("/home/mike/development/a/.env");

    const mode = runner("mode\n");
    expect(
      await grantEnvAccess(WSL, `${WSL}\\a\\.env`, { runner: mode.run, platform: "win32" }),
    ).toBe("mode");
  });

  test("a grant that did not happen is said to have failed", async () => {
    expect(
      await grantEnvAccess(WSL, `${WSL}\\a\\.env`, {
        runner: runner("failed\n").run,
        platform: "win32",
      }),
    ).toBe("failed");
    expect(
      await grantEnvAccess("C:\\repos\\ws", "C:\\repos\\ws\\a\\.env", {
        runner: runner("acl\n").run,
        platform: "win32",
      }),
    ).toBe("failed");
  });
});
