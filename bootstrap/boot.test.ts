// The `phoebe boot` engine-entry resolver. `boot` reads the mounted config,
// resolves the engine source, and turns it into the path it execs. For #40 only
// the local mount is wired; github resolution lands in #41. The exec itself
// (spawn + signal forwarding) is a thin shell around this decision, so the
// decision is what we pin here.

import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { LOCAL_ENGINE_DIR, resolveEngineEntry } from "./boot.ts";

describe("resolveEngineEntry", () => {
  test("a local source execs the engine CLI under the mounted dir", () => {
    const entry = resolveEngineEntry(
      { source: "local" },
      { localEngineDir: "/opt/phoebe-engine", exists: () => true },
    );
    expect(entry).toBe(join("/opt/phoebe-engine", "src", "cli.ts"));
  });

  test("local defaults to /opt/phoebe-engine", () => {
    expect(LOCAL_ENGINE_DIR).toBe("/opt/phoebe-engine");
    const entry = resolveEngineEntry({ source: "local" }, { exists: () => true });
    expect(entry).toBe(join(LOCAL_ENGINE_DIR, "src", "cli.ts"));
  });

  test("a local source with no mount fails loudly, naming the dir", () => {
    expect(() =>
      resolveEngineEntry(
        { source: "local" },
        { localEngineDir: "/opt/phoebe-engine", exists: () => false },
      ),
    ).toThrow(/no engine is mounted at \/opt\/phoebe-engine/);
  });

  test("a mounted-but-empty volume (dir present, no src/cli.ts) also fails loudly", () => {
    const entry = join("/opt/phoebe-engine", "src", "cli.ts");
    // Everything exists except the engine entry file — an empty/wrong mount.
    expect(() =>
      resolveEngineEntry(
        { source: "local" },
        { localEngineDir: "/opt/phoebe-engine", exists: (path) => path !== entry },
      ),
    ).toThrow(/no engine is mounted at \/opt\/phoebe-engine/);
  });

  test("a github source is not supported by boot yet (lands in #41)", () => {
    expect(() =>
      resolveEngineEntry(
        { source: "github", ref: "main", repo: "JesusFilm/phoebe" },
        { exists: () => true },
      ),
    ).toThrow(/github/i);
  });
});
