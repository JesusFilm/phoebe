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

  test("`init` scaffolds into the current directory by default", () => {
    expect(parseRelayArgs(["init"])).toEqual({ help: false, subcommand: "init" });
  });

  test("`init` takes the directory to scaffold under", () => {
    expect(parseRelayArgs(["init", "/srv/phoebe"])).toEqual({
      help: false,
      subcommand: "init",
      targetDir: "/srv/phoebe",
    });
  });

  test("no subcommand is not `serve` by default", () => {
    expect(parseRelayArgs([]).subcommand).toBeNull();
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
    { argv: ["serve", "--verbose"], why: "an unknown flag" },
    { argv: ["init", "--port", "9000"], why: "a serve flag on init" },
    { argv: ["init", "--data-dir", "/tmp/relay"], why: "the other serve flag on init" },
    { argv: ["init", "here", "there"], why: "two directories for init" },
    { argv: ["leave"], why: "a subcommand that does not exist yet" },
  ])("refuses $why", ({ argv }) => {
    expect(() => parseRelayArgs(argv)).toThrow();
  });
});

describe("the help text", () => {
  test("names both subcommands", () => {
    expect(RELAY_HELP_TEXT).toContain("phoebe relay serve");
    expect(RELAY_HELP_TEXT).toContain("phoebe relay init");
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
