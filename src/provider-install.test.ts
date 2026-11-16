// The provider install blocks (#869): reading a provider list, the default a
// scaffolded config names, and taking marked blocks out of a Dockerfile.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { PROVIDER_NAMES } from "./config-schema.ts";
import {
  defaultProviderFor,
  keepProviderBlocks,
  parseProviders,
  providerBlock,
  providerBlocksIn,
  providerForImage,
  removeProviderBlock,
} from "./provider-install.ts";

const TEMPLATE = readFileSync(
  join(import.meta.dirname, "..", "templates", "container", "Dockerfile"),
  "utf8",
);

const SMALL = [
  "FROM node",
  "",
  "# phoebe:provider claude",
  "RUN npm install -g claude",
  "# phoebe:end-provider claude",
  "",
  "# phoebe:provider cursor",
  "RUN cursor",
  "# phoebe:end-provider cursor",
  "",
  "USER phoebe",
].join("\n");

describe("parseProviders", () => {
  test("reads commas or spaces, keeps the order, drops a repeat", () => {
    expect(parseProviders("cursor,claude")).toEqual(["cursor", "claude"]);
    expect(parseProviders(" Codex  claude,codex ")).toEqual(["codex", "claude"]);
  });

  test("an unknown name or an empty list throws, naming the three", () => {
    expect(() => parseProviders("claude,gemini")).toThrow(/claude, cursor, codex/);
    expect(() => parseProviders(" , ")).toThrow(/at least one/);
  });
});

test("the config names claude when it is installed, else the first chosen", () => {
  expect(defaultProviderFor(["cursor", "claude"])).toBe("claude");
  expect(defaultProviderFor(["codex", "cursor"])).toBe("codex");
  expect(() => defaultProviderFor([])).toThrow();
});

describe("blocks", () => {
  test("the shipped template carries one complete block per provider", () => {
    expect(providerBlocksIn(TEMPLATE)).toEqual([...PROVIDER_NAMES]);
  });

  test("a block is read with its markers", () => {
    expect(providerBlock(SMALL, "cursor")).toEqual([
      "# phoebe:provider cursor",
      "RUN cursor",
      "# phoebe:end-provider cursor",
    ]);
    expect(providerBlock(SMALL, "codex")).toBeNull();
  });

  test("removing one takes the blank line before it, and nothing else", () => {
    expect(removeProviderBlock(SMALL, "claude")).toBe(
      [
        "FROM node",
        "",
        "# phoebe:provider cursor",
        "RUN cursor",
        "# phoebe:end-provider cursor",
        "",
        "USER phoebe",
      ].join("\n"),
    );
    expect(removeProviderBlock(SMALL, "codex")).toBeNull();
  });

  test("keeping some drops the rest", () => {
    expect(providerBlocksIn(keepProviderBlocks(SMALL, ["cursor"]))).toEqual(["cursor"]);
  });

  test("keeping one the file has no block for throws", () => {
    expect(() => keepProviderBlocks(SMALL, ["codex"])).toThrow(/phoebe:provider codex/);
  });

  test("the provider an image runs follows init's rule, and a file with no blocks says nothing", () => {
    expect(providerForImage(SMALL)).toBe("claude");
    expect(providerForImage(keepProviderBlocks(SMALL, ["cursor"]))).toBe("cursor");
    expect(providerForImage("FROM node\nUSER phoebe\n")).toBeNull();
  });

  test("an unclosed block is no block", () => {
    expect(providerBlock("# phoebe:provider claude\nRUN x", "claude")).toBeNull();
  });
});
