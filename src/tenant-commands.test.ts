// Multi-tenant lifecycle command tests (#95/#169): list / purge against temp
// config + data trees.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { STATUS_SNAPSHOT_FILE } from "./status-store.ts";

const fixtureRoot = join(import.meta.dirname, "..", "contracts", "fixtures", "status-v2");

/** Copy a published status-v2 corpus fixture in as one tenant's live snapshot. */
function installFixtureSnapshot(stateDir: string, name: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, STATUS_SNAPSHOT_FILE),
    readFileSync(join(fixtureRoot, `${name}.json`)),
  );
}
import {
  defaultRepoUrl,
  enumerateWorkspaceTenants,
  listTenants,
  parseSlug,
  purgeTenant,
  slugFromRemoteUrl,
  stripUrlCredentials,
} from "./tenant-commands.ts";

const MINIMAL_STATUS_V2 = {
  schemaVersion: "status-v2",
  updatedAt: "2026-07-30T12:00:00.000Z",
  runtime: {
    runtimeId: "runtime-1",
    instanceId: "instance-1",
    startedAt: "2026-07-30T12:00:00.000Z",
  },
  repository: { slug: "acme/widget", url: "https://github.com/acme/widget", defaultBranch: "main" },
  digests: {
    engine: "sha256:e",
    bootstrap: "sha256:b",
    config: "sha256:c",
    policy: "sha256:p",
    prompts: "sha256:pr",
    providerModel: "sha256:pm",
  },
  capabilities: ["status-v2"],
  lifecycle: { state: "idle" },
  activeWork: null,
  lastSuccess: null,
  lastFailure: null,
  control: {
    retry: { attempt: 0 },
    backoff: { active: false },
    quarantine: { active: false },
    drain: { requested: false },
  },
  health: { state: "healthy", telemetry: { writable: true, lastError: null, lastErrorAt: null } },
  journal: {
    earliestSequence: null,
    latestSequence: null,
    retainedSegments: 0,
    quarantinedTailCount: 0,
  },
  links: { repository: "https://github.com/acme/widget" },
};

let configDir: string;
let dataBase: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phoebe-cfg-"));
  dataBase = mkdtempSync(join(tmpdir(), "phoebe-data-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dataBase, { recursive: true, force: true });
});

describe("parseSlug / defaultRepoUrl / slugFromRemoteUrl", () => {
  test("splits a valid slug", () => {
    expect(parseSlug("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  test("rejects malformed slugs", () => {
    for (const bad of ["widget", "a/b/c", "acme/", "/widget", "acme /widget"]) {
      expect(() => parseSlug(bad)).toThrow(/Invalid repo slug/);
    }
  });
  test("rejects `.`/`..` path segments (no traversal out of the data base)", () => {
    // These match the char class but would escape the tenant tree / data base
    // once joined into a path (purgeTenant → rmSync). Must be refused.
    for (const bad of ["../x", "x/..", "../..", "./x", "x/.", "."]) {
      expect(() => parseSlug(bad)).toThrow(/Invalid repo slug/);
    }
    // A dot *inside* a segment is still fine — real repo names have them.
    expect(parseSlug("acme/foo.js")).toEqual({ owner: "acme", repo: "foo.js" });
  });
  test("derives the GitHub HTTPS url", () => {
    expect(defaultRepoUrl("acme/widget")).toBe("https://github.com/acme/widget.git");
  });
  test("slugFromRemoteUrl extracts owner/repo from common remote forms", () => {
    expect(slugFromRemoteUrl("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(slugFromRemoteUrl("git@github.com:acme/widget.git")).toBe("acme/widget");
  });
  test("slugFromRemoteUrl accepts scp remotes with a non-`git` username", () => {
    expect(slugFromRemoteUrl("deploy@git.example.com:acme/widget.git")).toBe("acme/widget");
  });
  test("slugFromRemoteUrl tolerates a terminal slash after `.git`", () => {
    expect(slugFromRemoteUrl("https://github.com/acme/widget.git/")).toBe("acme/widget");
    expect(slugFromRemoteUrl("git@github.com:acme/widget.git/")).toBe("acme/widget");
  });
});

describe("stripUrlCredentials", () => {
  test("removes userinfo from http(s) URLs so tokens never persist", () => {
    expect(stripUrlCredentials("https://x-access-token:ghs_tok@github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
    expect(stripUrlCredentials("https://user:pw@github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
  });
  test("leaves credential-free https and ssh remotes unchanged", () => {
    expect(stripUrlCredentials("https://github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
    expect(stripUrlCredentials("git@github.com:acme/widget.git")).toBe(
      "git@github.com:acme/widget.git",
    );
  });
});

describe("listTenants", () => {
  test("solo deployment has no fleet to list", async () => {
    expect(await listTenants({ configDir, dataBase })).toEqual({
      listings: [],
      declared: 0,
      live: 0,
      explicit: false,
      undeclared: [],
    });
  });

  test("reduces a version-mismatched snapshot to an available:false result carrying the received version", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { depth: 1 } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    writeFileSync(
      join(configDir, "widget", "phoebe.config.ts"),
      `export default { repoSlug: "acme/widget" };\n`,
    );
    const stateDir = join(dataBase, "acme", "widget", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, STATUS_SNAPSHOT_FILE),
      JSON.stringify({ ...MINIMAL_STATUS_V2, schemaVersion: "status-v3" }),
    );
    const { listings } = await listTenants({ configDir, dataBase });
    expect(listings[0]).toMatchObject({ configValid: true, envPresent: false, retainedData: true });
    expect(listings[0]?.status).toEqual({
      available: false,
      reason: "unsupported-version",
      receivedVersion: "status-v3",
      message: expect.stringContaining("status-v3"),
    });
  });

  test("workspace walk mode lists valid + held children with observational reasons", async () => {
    // Root declares workspace mode (#83); children live as siblings of the root
    // config. Valid child has status + .env; env-less is
    // config-ok without secrets; broken fails loadRepoSlug → held row.
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { depth: 1 }, engine: { source: "local" } };\n`,
    );
    mkdirSync(join(configDir, "valid"), { recursive: true });
    mkdirSync(join(configDir, "envless"), { recursive: true });
    mkdirSync(join(configDir, "broken"), { recursive: true });
    writeFileSync(join(configDir, "valid", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "envless", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "broken", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "valid", ".env"), "GH_TOKEN=x\n");
    const stateDir = join(dataBase, "acme", "valid", "state");
    installFixtureSnapshot(stateDir, "running");

    const { listings } = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: (path) => {
        const child = basename(dirname(path));
        if (child === "broken") throw new Error("parse failure");
        if (child === "valid") return "acme/valid";
        if (child === "envless") return "acme/envless";
        throw new Error(`unexpected path ${path}`);
      },
    });

    expect(listings.map((l) => l.path)).toEqual(["envless", "valid", "broken"]);
    expect(listings.find((l) => l.slug === "acme/valid")).toMatchObject({
      held: false,
      configValid: true,
      envPresent: true,
      retainedData: true,
    });
    expect(listings.find((l) => l.slug === "acme/valid")?.status).toMatchObject({
      available: true,
      status: { lifecycle: { state: "running" }, activeWork: { kind: "issues", issueNumber: 42 } },
    });
    expect(listings.find((l) => l.slug === "acme/envless")).toMatchObject({
      held: false,
      configValid: true,
      envPresent: false,
      retainedData: false,
      status: { available: false, reason: "not-found" },
    });
    expect(listings.find((l) => l.path === "broken")).toMatchObject({
      held: true,
      reason: "parse failure",
      slug: null,
      configValid: false,
      envPresent: false,
      retainedData: false,
      status: null,
    });
  });

  test("explicit arm prints one row per declared entry in declared order", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["widget", "sprocket", "gadget"] } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    mkdirSync(join(configDir, "sprocket"), { recursive: true });
    mkdirSync(join(configDir, "gadget"), { recursive: true });
    writeFileSync(join(configDir, "widget", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "gadget", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "widget", ".env"), "GH_TOKEN=x\n");
    const stateDir = join(dataBase, "acme", "widget", "state");
    installFixtureSnapshot(stateDir, "running");

    const result = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: (path) => {
        if (path.includes("widget")) return "acme/widget";
        if (path.includes("gadget")) return "acme/gadget";
        throw new Error("unexpected");
      },
    });

    expect(result.explicit).toBe(true);
    expect(result.declared).toBe(3);
    expect(result.live).toBe(2);
    expect(result.listings.map((l) => l.path)).toEqual(["widget", "sprocket", "gadget"]);
    expect(result.listings[0]).toMatchObject({
      slug: "acme/widget",
      held: false,
      configValid: true,
      retainedData: true,
    });
    expect(result.listings[1]).toMatchObject({
      slug: null,
      held: true,
      reason: "no phoebe.config.ts at directory root",
      configValid: false,
      retainedData: false,
    });
    expect(result.listings[2]).toMatchObject({ slug: "acme/gadget", held: false });
  });

  test("explicit arm surfaces origin-mismatch holds with slug and health columns", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["outboard"] } };\n`,
    );
    mkdirSync(join(configDir, "outboard"), { recursive: true });
    writeFileSync(join(configDir, "outboard", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "outboard", ".env"), "GH_TOKEN=x\n");
    const stateDir = join(dataBase, "acme", "outboard", "state");
    installFixtureSnapshot(stateDir, "running");

    const { listings } = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: () => "acme/outboard",
      readOriginUrl: () => "https://github.com/acme/other.git",
    });

    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      path: "outboard",
      slug: "acme/outboard",
      held: true,
      reason:
        'origin slug "acme/other" does not match config repoSlug "acme/outboard" ' +
        "(config is authoritative; fix the checkout origin or the child's repoSlug)",
      configValid: true,
      envPresent: true,
      retainedData: true,
    });
    expect(listings[0]?.status).toMatchObject({
      available: true,
      status: { lifecycle: { state: "running" }, activeWork: { kind: "issues", issueNumber: 42 } },
    });
  });

  test("explicit arm reports undeclared in-tree children after the declared block", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["widget"] } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    mkdirSync(join(configDir, "orphan"), { recursive: true });
    writeFileSync(join(configDir, "widget", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "orphan", "phoebe.config.ts"), "export default {};\n");

    const result = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: (path) => (path.includes("widget") ? "acme/widget" : "acme/orphan"),
    });

    expect(result.undeclared).toEqual(["orphan"]);
    expect(result.listings.map((l) => l.path)).toEqual(["widget"]);
  });

  test("explicit arm undeclared scan skips node_modules, .git, and dotdirs", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: [] } };\n`,
    );
    for (const name of ["node_modules", ".git", ".hidden", "real"]) {
      mkdirSync(join(configDir, name), { recursive: true });
      writeFileSync(join(configDir, name, "phoebe.config.ts"), "export default {};\n");
    }

    const { undeclared } = await listTenants({ configDir, dataBase });
    expect(undeclared).toEqual(["real"]);
  });

  test("explicit arm does not flag a declared entry as undeclared", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["./widget/"] } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    writeFileSync(join(configDir, "widget", "phoebe.config.ts"), "export default {};\n");

    const { undeclared } = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: () => "acme/widget",
    });
    expect(undeclared).toEqual([]);
  });

  test("walk arm leaves undeclared empty", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { depth: 1 } };\n`,
    );
    mkdirSync(join(configDir, "child"), { recursive: true });
    writeFileSync(join(configDir, "child", "phoebe.config.ts"), "export default {};\n");

    const { undeclared } = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: () => "acme/child",
    });
    expect(undeclared).toEqual([]);
  });
});

describe("enumerateWorkspaceTenants", () => {
  test("returns the DiscoveredTenants boot would supervise, envPath and all", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["widget", "absent"] } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    writeFileSync(join(configDir, "widget", "phoebe.config.ts"), "export default {};\n");

    const result = await enumerateWorkspaceTenants({
      configDir,
      loadRepoSlug: () => "acme/widget",
      readOriginUrl: () => null,
    });

    expect(result).not.toBeNull();
    expect(result!.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
    expect(result!.tenants[0]?.envPath).toBe(join(configDir, "widget", ".env"));
    expect(result!.holds.map((h) => h.dir)).toEqual([join(configDir, "absent")]);
  });

  test("surfaces the status-v2 queue lookahead when present", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { depth: 1 } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    writeFileSync(
      join(configDir, "widget", "phoebe.config.ts"),
      `export default { repoSlug: "acme/widget" };\n`,
    );
    const stateDir = join(dataBase, "acme", "widget", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, STATUS_SNAPSHOT_FILE),
      JSON.stringify({
        ...MINIMAL_STATUS_V2,
        queue: [
          { issueNumber: 100, blockedBy: [], workable: true },
          { issueNumber: 103, blockedBy: [100, 101], workable: false },
        ],
      }),
    );
    const { listings } = await listTenants({ configDir, dataBase });
    expect(listings[0]?.queue).toEqual([
      { issueNumber: 100, blockedBy: [], workable: true },
      { issueNumber: 103, blockedBy: [100, 101], workable: false },
    ]);
  });

  test("defaults to an empty queue when no status-v2 snapshot exists yet", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { depth: 1 } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    writeFileSync(
      join(configDir, "widget", "phoebe.config.ts"),
      `export default { repoSlug: "acme/widget" };\n`,
    );
    const { listings } = await listTenants({ configDir, dataBase });
    expect(listings[0]?.queue).toEqual([]);
  });

  test("relocates a child's envPath when its config sets configDir (#98)", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["widget"] } };\n`,
    );
    mkdirSync(join(configDir, "widget"), { recursive: true });
    writeFileSync(
      join(configDir, "widget", "phoebe.config.ts"),
      `export default { repoSlug: "acme/widget", configDir: ".phoebe" };\n`,
    );

    const result = await enumerateWorkspaceTenants({ configDir, readOriginUrl: () => null });
    expect(result!.tenants[0]?.envPath).toBe(join(configDir, "widget", ".phoebe", ".env"));
  });

  test("is null when the root is not a workspace, so callers can fall through", async () => {
    writeFileSync(join(configDir, "phoebe.config.ts"), "export default {};\n");
    expect(await enumerateWorkspaceTenants({ configDir })).toBeNull();
  });
});

describe("purgeTenant", () => {
  /** A workspace root declaring `child/` as its one tenant, with data retained. */
  function writeWorkspaceWithChild(): void {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { tenants: ["child"] } };\n`,
    );
    mkdirSync(join(configDir, "child"), { recursive: true });
    writeFileSync(join(configDir, "child", "phoebe.config.ts"), "export default {};\n");
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });
  }

  test("wipes retained data once no config claims the slug", async () => {
    writeWorkspaceWithChild();
    // The operator unregistered and deleted the child; only its data remains.
    rmSync(join(configDir, "child"), { recursive: true, force: true });
    writeFileSync(join(configDir, "phoebe.config.ts"), `export default { workspace: {} };\n`);

    const { purged } = await purgeTenant({
      configDir,
      dataBase,
      slug: "acme/widget",
      confirm: true,
    });
    expect(purged).toBe(join(dataBase, "acme", "widget"));
    expect(existsSync(purged)).toBe(false);
  });

  test("refuses without confirm", async () => {
    await expect(
      purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: false }),
    ).rejects.toThrow(/without --yes/);
  });

  test("refuses while a workspace child still claims the slug, naming no removed verb", async () => {
    writeWorkspaceWithChild();
    await expect(
      purgeTenant({
        configDir,
        dataBase,
        slug: "acme/widget",
        confirm: true,
        loadRepoSlug: () => "acme/widget",
      }),
    ).rejects.toThrow(/still has a live config.*workspace\.tenants/s);
    expect(existsSync(join(dataBase, "acme", "widget"))).toBe(true);
  });

  test("refuses while a *held* child still claims the slug (it may still be running)", async () => {
    writeWorkspaceWithChild();
    // Origin mismatch → discovery holds the dir but recovers its slug (#140).
    await expect(
      purgeTenant({
        configDir,
        dataBase,
        slug: "acme/widget",
        confirm: true,
        loadRepoSlug: () => "acme/widget",
        readOriginUrl: () => "https://github.com/acme/other.git",
      }),
    ).rejects.toThrow(/still has a live config/);
  });

  test("refuses when the solo root config is itself that tenant", async () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { repoSlug: "acme/widget" };\n`,
    );
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });
    await expect(
      purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: true }),
    ).rejects.toThrow(/still has a live config/);
  });

  test("throws when there is no retained data", async () => {
    await expect(
      purgeTenant({ configDir, dataBase, slug: "acme/ghost", confirm: true }),
    ).rejects.toThrow(/No retained data/);
  });
});
