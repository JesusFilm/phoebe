// The sentry kind's options block: two required fields, nine defaults, and a
// typo net over the root — validated at registration, not mid-unit.

import { describe, expect, test } from "vite-plus/test";
import { resolveSentryOptions, SENTRY_OPTION_DEFAULTS } from "./options.ts";

const AT = "pipelines.intake.kinds.sentry";

describe("resolveSentryOptions", () => {
  test("org and project are enough; everything else takes its default", () => {
    expect(resolveSentryOptions({ org: "acme", project: 4507 }, AT)).toEqual({
      org: "acme",
      project: 4507,
      ...SENTRY_OPTION_DEFAULTS,
    });
  });

  test("every field is overridable and the url loses its trailing slash", () => {
    const resolved = resolveSentryOptions(
      {
        org: "acme",
        project: 1,
        url: "https://glitchtip.corp/",
        collector: "glitchtip",
        window: "7d",
        minEvents: 5,
        environments: ["staging", "production"],
        levels: ["fatal"],
        label: "crash",
        triagedLabel: "crash:triaged",
        applyReadyLabel: true,
      },
      AT,
    );
    expect(resolved.url).toBe("https://glitchtip.corp");
    expect(resolved.collector).toBe("glitchtip");
    expect(resolved.window).toBe("7d");
    expect(resolved.minEvents).toBe(5);
    expect(resolved.environments).toEqual(["staging", "production"]);
    expect(resolved.levels).toEqual(["fatal"]);
    expect(resolved.applyReadyLabel).toBe(true);
  });

  test.each([
    [undefined, "needs an options block"],
    [{ project: 1 }, "`org` must be a non-empty string"],
    [{ org: "acme" }, "`project` must be the numeric project id"],
    [{ org: "acme", project: "my-slug" }, "`project` must be the numeric project id"],
    [{ org: "acme", project: 1, url: "sentry.io" }, "`url`: collector url is not an absolute URL"],
    [
      { org: "acme", project: 1, collector: "bugsink" },
      "`collector` must be one of sentry, glitchtip",
    ],
    [{ org: "acme", project: 1, window: "yesterday" }, '`window` must be a period like "24h"'],
    [{ org: "acme", project: 1, minEvents: 0 }, "`minEvents` must be a positive integer"],
    [{ org: "acme", project: 1, environments: [] }, "`environments` must be a non-empty array"],
    [{ org: "acme", project: 1, levels: ["error", 3] }, "`levels` must be a non-empty array"],
    [{ org: "acme", project: 1, applyReadyLabel: "yes" }, "`applyReadyLabel` must be a boolean"],
    [{ org: "acme", project: 1, projectSlug: "x" }, "unknown option `projectSlug`"],
  ])("refuses %j", (raw, message) => {
    expect(() => resolveSentryOptions(raw, AT)).toThrow(`${AT}: `);
    expect(() => resolveSentryOptions(raw, AT)).toThrow(message);
  });
});
