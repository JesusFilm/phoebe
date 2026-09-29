import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfigFieldFacts } from "phoebe-agent/contracts";
import { ConfigSpace, landingConfigView, valueOfDraft } from "./config-form.tsx";
import { install } from "./test-fixture.ts";

const FIELDS: ConfigFieldFacts[] = [
  { path: "repoSlug", env: "PHOEBE_REPO_SLUG", type: "string", state: "set", value: "acme/a" },
  {
    path: "defaultBranch",
    env: "PHOEBE_DEFAULT_BRANCH",
    type: "string",
    state: "unset",
    default: "main",
  },
  {
    path: "prScope",
    env: "PHOEBE_PR_SCOPE",
    type: "enum",
    values: ["phoebe", "all"],
    state: "set",
    value: "all",
  },
  {
    path: "checkCommand",
    env: "PHOEBE_CHECK_COMMAND",
    type: "string",
    state: "computed",
    raw: "commands.check",
  },
];

const file = (fields?: ConfigFieldFacts[]) => ({
  kind: "file" as const,
  path: "/repos/a/phoebe.config.ts",
  text: 'export default defineConfig({ repoSlug: "acme/a" })\n',
  fingerprint: "sha256:aa",
  ...(fields === undefined ? {} : { fields }),
});

function space(fields?: ConfigFieldFacts[]) {
  return renderToStaticMarkup(
    <ConfigSpace
      install={install()}
      config={file(fields)}
      running={false}
      receipt={null}
      onStart={() => undefined}
      label="the root config"
      file={<p>by hand</p>}
    />,
  );
}

describe("one config on the config tab", () => {
  test("opens on the form, with the file one press behind it", () => {
    const markup = space(FIELDS);

    expect(markup).toMatch(/class="config-view current" aria-pressed="true">Form</);
    expect(markup).toMatch(/class="config-view" aria-pressed="false">File</);
    expect(markup).toContain('aria-label="Settings in the root config"');
    // The file's text and the by-hand form are the other view's.
    expect(markup).not.toContain("defineConfig");
    expect(markup).not.toContain("by hand");
  });

  test("a row per setting: the value the file holds, or what applies without one", () => {
    const markup = space(FIELDS);

    expect(markup).toMatch(/aria-label="repoSlug"[^>]*value="acme\/a"/);
    expect(markup).toMatch(/aria-label="defaultBranch"[^>]*placeholder="main"/);
    expect(markup).toContain("Defaults to main.");
    expect(markup).toContain("PHOEBE_DEFAULT_BRANCH");
  });

  test("an enum is a choice among its values", () => {
    const markup = space(FIELDS);

    expect(markup).toMatch(/<select[^>]*aria-label="prScope"/);
    expect(markup).toContain('<option value="phoebe">phoebe</option>');
    expect(markup).toMatch(/<option value="all" selected="">all<\/option>/);
  });

  test("a computed value is shown as written, with nothing to save", () => {
    const markup = space([FIELDS[3]!]);

    expect(markup).toMatch(/readonly=""[^>]*value="commands.check"/i);
    expect(markup).not.toContain(">Save<");
  });

  test("nothing has changed yet, so nothing can be saved yet", () => {
    expect(space([FIELDS[0]!])).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save</);
  });

  test("with no settings read, it opens on the file", () => {
    expect(landingConfigView(file())).toBe("file");
    expect(landingConfigView(file([]))).toBe("file");
    expect(landingConfigView(file(FIELDS))).toBe("form");

    const markup = space();
    expect(markup).toContain("defineConfig");
    expect(markup).toContain("by hand");
  });
});

describe("what a row's draft saves as", () => {
  test("a number setting saves a number, a boolean a boolean, a string as typed", () => {
    expect(valueOfDraft({ type: "number" }, " 300000 ")).toBe(300000);
    expect(valueOfDraft({ type: "boolean" }, "false")).toBe(false);
    expect(valueOfDraft({ type: "string" }, "300000")).toBe("300000");
    expect(valueOfDraft({ type: "enum" }, "all")).toBe("all");
  });

  test("an empty box, or a number box holding something else, is nothing to save", () => {
    expect(valueOfDraft({ type: "string" }, "  ")).toBeNull();
    expect(valueOfDraft({ type: "number" }, "soon")).toBeNull();
    expect(valueOfDraft({ type: "integer" }, "1.5")).toBeNull();
  });
});
