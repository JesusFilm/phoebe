import { describe, expect, test } from "vite-plus/test";
import { parseRelayArgs, RELAY_HELP_TEXT } from "./cli.ts";

describe("parseRelayArgs", () => {
  test("`serve` with nothing else takes every default", () => {
    expect(parseRelayArgs(["serve"])).toEqual({ help: false, subcommand: "serve" });
  });

  test("reads --port and --data-dir", () => {
    expect(parseRelayArgs(["serve", "--port", "9000", "--data-dir", "/tmp/relay"])).toEqual({
      help: false,
      subcommand: "serve",
      port: 9000,
      dataDir: "/tmp/relay",
    });
  });

  test("no subcommand is not `serve` by default", () => {
    expect(parseRelayArgs([]).subcommand).toBeNull();
  });

  test("`leave` is its own subcommand and takes nothing", () => {
    expect(parseRelayArgs(["leave"])).toEqual({ help: false, subcommand: "leave" });
  });

  test.each([
    { argv: ["leave", "--data-dir", "/tmp/whatever"], why: "the relay volume" },
    { argv: ["leave", "--port", "9000"], why: "a port" },
  ])("`leave` refuses $why, which belongs to `serve`", ({ argv }) => {
    expect(() => parseRelayArgs(argv)).toThrow(/takes no options/);
  });

  test("--help wins over everything", () => {
    expect(parseRelayArgs(["serve", "--help"]).help).toBe(true);
    expect(parseRelayArgs(["-h"]).help).toBe(true);
  });

  test.each([
    { argv: ["serve", "--port"], why: "a flag with no value" },
    { argv: ["serve", "--port", "--data-dir"], why: "a flag whose value is another flag" },
    { argv: ["serve", "--port", "not-a-number"], why: "a port that is not a number" },
    { argv: ["serve", "--port", "70000"], why: "a port outside the range" },
    { argv: ["init"], why: "a subcommand that does not exist yet" },
    { argv: ["serve", "--verbose"], why: "an unknown flag" },
  ])("refuses $why", ({ argv }) => {
    expect(() => parseRelayArgs(argv)).toThrow();
  });
});

describe("the help text", () => {
  test("names both subcommands", () => {
    expect(RELAY_HELP_TEXT).toContain("phoebe relay serve");
    expect(RELAY_HELP_TEXT).toContain("phoebe relay leave");
  });

  test("names all four environment variables", () => {
    for (const name of [
      "RELAY_HOST",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "ALLOWED_EMAILS",
    ]) {
      expect(RELAY_HELP_TEXT).toContain(name);
    }
  });
});
