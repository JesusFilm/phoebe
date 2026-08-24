// Migration m003: lift the pinned phoebe-agent version from the RUN line into
// an ARG PHOEBE_AGENT_VERSION, making it machine-editable.
//
// detect returns null for:
//   - no container/Dockerfile (host deployments have no container/)
//   - already migrated (ARG PHOEBE_AGENT_VERSION present)
//   - unpinned: `npm install -g phoebe-agent` with no @version — the template
//     ships this way intentionally; pinning it to any number would be inventing
//     policy, so we leave it alone
//
// Pinned lines whose structure cannot be safely rewritten (&&-chains, line
// continuations, multi-package installs) get a ConfigRefusal — the operator is
// shown the exact two-line edit to make by hand.

import { ConfigRefusal } from "../config-handle.ts";
import type { Migration } from "../migrate.ts";

const DOCKERFILE_REL_PATH = "container/Dockerfile";

// Any occurrence of a pinned phoebe-agent package — used by detect to decide
// whether to apply at all. Captures the version string.
const PINNED_VERSION_RE = /\bphoebe-agent@(\d+\.\d+\.\d+)\b/;

// A simple single-line RUN that only installs phoebe-agent (possibly with
// surrounding whitespace). Line continuations, &&-chains, or extra packages
// on the same line fall through to ConfigRefusal.
//
// Breakdown:
//   ^              — start of a line (multiline mode)
//   RUN[ \t]+      — the RUN keyword and mandatory whitespace (no \n between them)
//   npm[ \t]+install[ \t]+-g[ \t]+ — the npm install -g invocation
//   (prefix)       — everything up to and including the final space before the package
//   phoebe-agent@  — package name with @
//   (semver)       — captured version digits
//   [ \t]*$        — nothing but optional horizontal whitespace to end of line
const SIMPLE_RUN_RE =
  /^(RUN[ \t]+npm[ \t]+install[ \t]+-g[ \t]+)phoebe-agent@(\d+\.\d+\.\d+)[ \t]*$/m;

type DetectData = { content: string; version: string };

export const containerLauncherArgMigration: Migration = {
  id: "container-launcher-arg",
  title: "Lift PHOEBE_AGENT_VERSION to an ARG",
  appliesTo: ["solo-root", "workspace-root"] as const,

  detect(_dir, readFile) {
    const content = readFile(DOCKERFILE_REL_PATH);
    if (content === null) return null;
    if (/^ARG[ \t]+PHOEBE_AGENT_VERSION\b/m.test(content)) return null;
    const match = PINNED_VERSION_RE.exec(content);
    if (match === null) return null;
    return { content, version: match[1] } satisfies DetectData;
  },

  describe(data) {
    const { version } = data as DetectData;
    return `add ARG PHOEBE_AGENT_VERSION=${version} and reference it in the RUN line`;
  },

  apply(_dir, data, _readFile) {
    const { content, version } = data as DetectData;

    const m = SIMPLE_RUN_RE.exec(content);
    if (m === null) {
      return new ConfigRefusal(
        `In container/Dockerfile, replace the pinned phoebe-agent@${version} install with:\n\n` +
          `  ARG PHOEBE_AGENT_VERSION=${version}\n` +
          `  RUN npm install -g phoebe-agent@\${PHOEBE_AGENT_VERSION}`,
      );
    }

    const runLine = m[0]!;
    const prefix = m[1]!;
    const newContent = content.replace(
      runLine,
      `ARG PHOEBE_AGENT_VERSION=${version}\n${prefix}phoebe-agent@\${PHOEBE_AGENT_VERSION}`,
    );
    return { [DOCKERFILE_REL_PATH]: newContent };
  },
};

export default containerLauncherArgMigration;
