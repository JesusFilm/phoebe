import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfigFieldFacts } from "phoebe-agent/contracts";
import {
  ConfigSpace,
  configGroups,
  landingConfigView,
  saveRequest,
  valueOfDraft,
} from "./config-form.tsx";
import { install } from "./test-fixture.ts";

const FIELDS: ConfigFieldFacts[] = [
  {
    path: "repoSlug",
    scope: "tenant",
    env: "PHOEBE_REPO_SLUG",
    type: "string",
    state: "set",
    value: "acme/a",
  },
  {
    path: "defaultBranch",
    scope: "tenant",
    env: "PHOEBE_DEFAULT_BRANCH",
    type: "string",
    state: "unset",
    default: "main",
  },
  {
    path: "prScope",
    scope: "tenant",
    env: "PHOEBE_PR_SCOPE",
    type: "enum",
    values: ["phoebe", "all"],
    state: "set",
    value: "all",
  },
  {
    path: "checkCommand",
    scope: "tenant",
    env: "PHOEBE_CHECK_COMMAND",
    type: "string",
    state: "computed",
    raw: "commands.check",
  },
];

const ROOT: ConfigFieldFacts[] = [
  {
    path: "workspace.depth",
    scope: "deployment",
    type: "integer",
    state: "set",
    value: 2,
    locked: "The fleet declaration is a git edit.",
  },
  {
    path: "reporting.maintainers",
    scope: "deployment",
    type: "boolean",
    state: "set",
    value: false,
    default: false,
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
    expect(markup).toContain('aria-label="Repository in the root config"');
    // The file's text and the by-hand form are the other view's.
    expect(markup).not.toContain("defineConfig");
    expect(markup).not.toContain("by hand");
  });

  test("a row per setting: the value the file holds, or what applies without one", () => {
    const markup = space(FIELDS);

    expect(markup).toMatch(/aria-label="repoSlug"[^>]*value="acme\/a"/);
    expect(markup).toMatch(/aria-label="defaultBranch"[^>]*placeholder="main"/);
    expect(markup).toContain("Defaults to main.");
    expect(markup).not.toContain("PHOEBE_DEFAULT_BRANCH");
  });

  test("an enum is a choice among its values, drawn by the console rather than the browser", () => {
    const markup = space(FIELDS);

    // Coss UI's select: a button showing the value, never a native <select>.
    expect(markup).toMatch(/<button[^>]*data-slot="select-trigger"[^>]*aria-label="prScope"/);
    expect(markup).toMatch(/data-slot="select-value"[^>]*>all</);
    expect(markup).not.toContain("<select");
    // Unset, the trigger says so and what applies, not a value that reads as set.
    const unset = space([{ ...ROOT[1]!, state: "unset", value: undefined }]);
    expect(unset).toMatch(/data-slot="select-value"[^>]*>not set \(false\)</);
  });

  test("a text setting with values worth offering is a box that offers them and takes anything", () => {
    const markup = space([
      {
        path: "model",
        scope: "tenant",
        type: "string",
        state: "unset",
        suggestions: ["composer-2.5", "claude-sonnet-4-6"],
      },
    ]);

    // A combobox whose input is the draft: what is typed is what is saved.
    expect(markup).toMatch(/<input[^>]*data-slot="combobox-input"[^>]*aria-label="model"/);
    expect(markup).toMatch(/data-slot="combobox-trigger"/);
    // With nothing typed, the box shows what applies without it.
    expect(markup).toMatch(/aria-label="model"[^>]*placeholder="not set"/);
    // A plain string setting stays a plain box.
    expect(space([FIELDS[0]!])).not.toContain("combobox");
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

describe("whose rows a config's form has", () => {
  test("a workspace root has the deployment's rows and no tenant's, under no heading", () => {
    const markup = space(ROOT);

    expect(markup).toContain('aria-label="Deployment in the root config"');
    expect(markup).not.toContain("config-group");
    expect(markup).not.toContain("repoSlug");
  });

  test("a locked row says why, shows the value, and has nothing to save", () => {
    const markup = space([ROOT[0]!]);

    expect(markup).toContain("The fleet declaration is a git edit.");
    expect(markup).toMatch(/aria-label="workspace.depth"[^>]*readonly=""[^>]*value="2"/i);
    expect(markup).not.toContain(">Save<");
  });

  test("a row is named for a person, with the path beside it and a sentence under it", () => {
    const markup = space([FIELDS[0]!, ROOT[1]!]);

    expect(markup).toContain("Repository<span");
    expect(markup).toContain('class="mono setting-path">repoSlug</span>');
    expect(markup).toContain("The GitHub owner/repo Phoebe works");
    expect(markup).toContain("Report faults to the maintainers");
    expect(markup).not.toContain("outranks the file");
  });

  test("a path this console has no words for is shown as itself", () => {
    const markup = space([{ ...FIELDS[0]!, path: "somethingNew" }]);

    expect(markup).toMatch(/>somethingNew<\/label>/);
    expect(markup).not.toContain("setting-path");
  });

  test("a solo install's config has both kinds, the deployment's first, each headed", () => {
    const groups = configGroups([...FIELDS, ...ROOT]);

    expect(groups.map((group) => [group.heading, group.alone, group.fields.length])).toEqual([
      ["Deployment", false, 2],
      ["Repository", false, 4],
    ]);
    expect(space([...FIELDS, ...ROOT])).toContain('<h3 class="config-group">Deployment</h3>');
  });
});

describe("what a row's Save runs", () => {
  test("a config set against the fingerprint the form was drawn from", () => {
    expect(
      saveRequest({
        install: "/repos/a",
        field: { path: "repoSlug" },
        value: "acme/b",
        fingerprint: "sha256:aa",
      }),
    ).toEqual({
      install: "/repos/a",
      verb: "config set",
      path: "repoSlug",
      value: "acme/b",
      fingerprint: "sha256:aa",
    });
  });

  test("a tenant's row names the tenant", () => {
    expect(
      saveRequest({
        install: "/repos/ws",
        field: { path: "repoSlug" },
        value: "acme/b",
        fingerprint: "sha256:aa",
        tenant: "/repos/ws/a",
      }),
    ).toMatchObject({ verb: "config set", tenant: "/repos/ws/a" });
  });

  test("the engine's ref is an upgrade of the engine to that ref, not a config set", () => {
    expect(
      saveRequest({
        install: "/repos/a",
        field: { path: "engine.ref", via: "upgrade" },
        value: "v0.14.0",
        fingerprint: "sha256:aa",
      }),
    ).toEqual({
      install: "/repos/a",
      verb: "upgrade",
      check: false,
      target: "engine",
      ref: "v0.14.0",
    });
  });

  test("the engine's ref is a box that offers refs and takes any", () => {
    const markup = space([
      {
        path: "engine.ref",
        scope: "deployment",
        type: "string",
        state: "set",
        value: "main",
        via: "upgrade",
        suggestions: ["main", "v0.13.0"],
      },
    ]);

    expect(markup).toMatch(/<input[^>]*data-slot="combobox-input"[^>]*aria-label="engine.ref"/);
    expect(markup).toMatch(/aria-label="engine.ref"[^>]*value="main"/);
    expect(markup).toContain("Saving it runs an upgrade");
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
