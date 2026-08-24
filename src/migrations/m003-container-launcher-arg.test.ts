// m003 — container-launcher-arg migration unit tests.
//
// Contract:
//   detect: null when no container/Dockerfile, when PHOEBE_AGENT_VERSION ARG
//           is already present, or when the install is unpinned.
//   detect: non-null when a pinned phoebe-agent@<version> appears with no ARG.
//   apply: rewrites a simple single-line RUN, inserting the ARG above it.
//   apply: returns ConfigRefusal when the RUN line is too complex to rewrite
//          (&&-chain, line continuation, multi-package), with the exact edit.
//   idempotence: apply → detect returns null.

import { describe, expect, test } from "vite-plus/test";
import { isConfigRefusal } from "../config-handle.ts";
import { containerLauncherArgMigration as m } from "./m003-container-launcher-arg.ts";

// A minimal Dockerfile fragment around the bootstrapper RUN line.
function dockerfile(runLine: string, extras = ""): string {
  return [
    "FROM node:24-bookworm-slim",
    "",
    extras,
    runLine,
    "",
    'ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "boot"]',
    "CMD []",
    "",
  ]
    .filter((l) => l !== "" || l === "")
    .join("\n");
}

function noop(_relPath: string): string | null {
  return null;
}

function withDockerfile(content: string) {
  return (relPath: string): string | null => (relPath === "container/Dockerfile" ? content : null);
}

// ----------------------------------------------------------------- detect

describe("detect", () => {
  test("returns null when container/Dockerfile is absent", () => {
    expect(m.detect(".", noop)).toBeNull();
  });

  test("returns null when already migrated (ARG PHOEBE_AGENT_VERSION present)", () => {
    const content = dockerfile(
      "ARG PHOEBE_AGENT_VERSION=0.3.0\nRUN npm install -g phoebe-agent@${PHOEBE_AGENT_VERSION}",
    );
    expect(m.detect(".", withDockerfile(content))).toBeNull();
  });

  test("returns null when install is unpinned (no @version)", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent");
    expect(m.detect(".", withDockerfile(content))).toBeNull();
  });

  test("returns non-null when a pinned phoebe-agent@version is present without ARG", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0");
    const data = m.detect(".", withDockerfile(content));
    expect(data).not.toBeNull();
    expect((data as { version: string }).version).toBe("0.3.0");
  });

  test("extracts the correct version", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@1.23.456");
    const data = m.detect(".", withDockerfile(content));
    expect((data as { version: string }).version).toBe("1.23.456");
  });
});

// ----------------------------------------------------------------- apply (simple rewrite)

describe("apply — simple RUN rewrite", () => {
  test("inserts ARG line before RUN and substitutes the version reference", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content));
    expect(isConfigRefusal(result)).toBe(false);
    const written = (result as Record<string, string>)["container/Dockerfile"]!;
    expect(written).toContain("ARG PHOEBE_AGENT_VERSION=0.3.0");
    expect(written).toContain("RUN npm install -g phoebe-agent@${PHOEBE_AGENT_VERSION}");
    expect(written).not.toContain("phoebe-agent@0.3.0");
  });

  test("ARG line appears immediately before the RUN line", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content)) as Record<string, string>;
    const lines = result["container/Dockerfile"]!.split("\n");
    const runIdx = lines.findIndex((l) => l.startsWith("RUN npm install -g phoebe-agent@"));
    const argIdx = lines.findIndex((l) => l.startsWith("ARG PHOEBE_AGENT_VERSION="));
    expect(argIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    expect(runIdx).toBe(argIdx + 1);
  });

  test("content outside the rewritten section is untouched", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.5.0");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content)) as Record<string, string>;
    const written = result["container/Dockerfile"]!;
    expect(written).toContain("FROM node:24-bookworm-slim");
    expect(written).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "boot"]');
  });
});

// ----------------------------------------------------------------- apply (ConfigRefusal)

describe("apply — ConfigRefusal on unexpected shapes", () => {
  test("&&-chain in the RUN line", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0 && npm cache clean --force");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content));
    expect(isConfigRefusal(result)).toBe(true);
  });

  test("line continuation in the RUN block", () => {
    const content = dockerfile("RUN npm install -g \\\n  phoebe-agent@0.3.0");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content));
    expect(isConfigRefusal(result)).toBe(true);
  });

  test("extra package on the same RUN line", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0 some-other-tool");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content));
    expect(isConfigRefusal(result)).toBe(true);
  });

  test("ConfigRefusal instruction names the version and shows the exact edit", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0 && npm cache clean --force");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content));
    expect(isConfigRefusal(result)).toBe(true);
    if (isConfigRefusal(result)) {
      expect(result.instruction).toContain("0.3.0");
      expect(result.instruction).toContain("ARG PHOEBE_AGENT_VERSION=0.3.0");
      expect(result.instruction).toContain("phoebe-agent@${PHOEBE_AGENT_VERSION}");
    }
  });
});

// ----------------------------------------------------------------- idempotence

describe("idempotence", () => {
  test("detect returns null after apply rewrites the file", () => {
    const content = dockerfile("RUN npm install -g phoebe-agent@0.3.0");
    const data = m.detect(".", withDockerfile(content))!;
    const result = m.apply(".", data, withDockerfile(content)) as Record<string, string>;
    const written = result["container/Dockerfile"]!;
    expect(m.detect(".", withDockerfile(written))).toBeNull();
  });
});

// ----------------------------------------------------------------- appliesTo

describe("appliesTo", () => {
  test("includes solo-root and workspace-root, not tenant", () => {
    expect(m.appliesTo).toContain("solo-root");
    expect(m.appliesTo).toContain("workspace-root");
    expect(m.appliesTo).not.toContain("tenant");
  });
});
