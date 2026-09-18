// The relay must not put a listener in the deployment container (#538, map
// #497 reaffirming #469). The deployment dials *out* to the relay and nothing
// dials in; that is what lets a deployment run behind any NAT, and what keeps
// its attack surface at zero inbound ports.
//
// Two ways that could quietly stop being true, and one assertion each: a port
// appears in the container scaffold, or the deployment's own entry point grows
// a path into the relay's server. `phoebe relay serve` is a separate image with
// a separate compose file and its own volume; the only edge from this repo's
// deployment code into `relay/` is the CLI verb, reached by typing it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const repoRoot = join(import.meta.dirname, "..");

/** Comment lines quote the very words being asserted against; drop them. */
function instructionsOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return trimmed !== "" && !trimmed.startsWith("#");
    })
    .join("\n");
}

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

describe("the deployment container gains no listener", () => {
  test.each([
    "templates/container/Dockerfile",
    "templates/container/compose.yml",
    "templates/container/compose.local.yml",
  ])("%s publishes no port", (relPath) => {
    const source = instructionsOnly(readFileSync(join(repoRoot, relPath), "utf8"));

    expect(source).not.toMatch(/^\s*EXPOSE\b/m);
    expect(source).not.toMatch(/^\s*ports:/m);
  });

  test("only the `relay` verb reaches the relay's code", () => {
    const importers = [
      ...sourceFilesUnder(join(repoRoot, "src")),
      ...sourceFilesUnder(join(repoRoot, "bootstrap")),
    ]
      .filter((file) => /["']\.\.\/relay\//.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(repoRoot.length + 1));

    expect(importers).toEqual(["src/cli.ts"]);
  });

  test("and it reaches it lazily, so an engine run never loads a server", () => {
    const cli = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");

    expect(cli).toContain(`await import("../relay/cli.ts")`);
    expect(cli).not.toMatch(/^import .* from "\.\.\/relay\//m);
  });
});
