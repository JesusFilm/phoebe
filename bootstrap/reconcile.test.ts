// The reconcile watch (#42): while the engine runs, `phoebe boot` polls the
// mounted config and the tracked ref, and on a change drains the engine
// (SIGTERM) and relaunches it in the same container.
//
// Two pure seams are tested here: `detectChange`, the decision "is the running
// engine stale?" — comparing what is live now against what the running engine
// was launched from — and `configFingerprint`, the stat that makes a no-change
// poll cheap. The loop that acts on them is bootstrap/supervise-fleet.ts, and it
// is tested there (solo included, since #416).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { configFingerprint, detectChange } from "./reconcile.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("detectChange", () => {
  test("nothing moved — no relaunch", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "1:2", remoteSha: SHA_A },
      }),
    ).toBeNull();
  });

  test("the mounted config changed — relaunch to re-read the engine source", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "9:9", remoteSha: SHA_A },
      }),
    ).toBe("config");
  });

  test("the tracked ref advanced past the running commit — relaunch onto it", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "1:2", remoteSha: SHA_B },
      }),
    ).toBe("ref");
  });

  test("a pinned ref reports nothing to watch, so it never relaunches", () => {
    // `lsRemoteBranchSha` returns null for a pinned SHA/tag; the running commit
    // is whatever that pin resolved to, and must not be read as a mismatch.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "1:2", remoteSha: null },
      }),
    ).toBeNull();
  });

  test("a local mount has no commit to compare, so the ref-watch is inert", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: null },
        current: { config: "1:2", remoteSha: SHA_B },
      }),
    ).toBeNull();
  });

  test("an unreadable config is treated as unchanged, not as a change", () => {
    // A config being rewritten (or a mount blipping) must not relaunch the
    // engine on the strength of a failed stat.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: null, remoteSha: SHA_A },
      }),
    ).toBeNull();
  });

  test("a config change is reported ahead of a ref change when both moved", () => {
    // Re-reading the config may itself change which ref is tracked, so it wins.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A },
        current: { config: "9:9", remoteSha: SHA_B },
      }),
    ).toBe("config");
  });

  test("a quarantined tip is not a change to chase — the fallback holds", () => {
    // Mid-fallback: the engine runs the last-good commit (SHA_A) while the
    // branch still points at the crash-looping one (SHA_B). Reading that as a
    // ref change would relaunch straight back into the commit boot is avoiding.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A, quarantinedSha: SHA_B },
        current: { config: "1:2", remoteSha: SHA_B },
      }),
    ).toBeNull();
  });

  test("the branch moving past the quarantined commit ends the fallback", () => {
    // A fix landed. The tip is no longer the bad commit, so reconcile resumes.
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A, quarantinedSha: SHA_B },
        current: { config: "1:2", remoteSha: SHA_C },
      }),
    ).toBe("ref");
  });

  test("a config edit is still honoured while a commit is quarantined", () => {
    expect(
      detectChange({
        launched: { config: "1:2", sha: SHA_A, quarantinedSha: SHA_B },
        current: { config: "9:9", remoteSha: SHA_B },
      }),
    ).toBe("config");
  });
});

describe("configFingerprint", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    path = join(dir, "phoebe.config.ts");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stable file fingerprints the same twice (a no-change poll is a stat)", () => {
    writeFileSync(path, "export default {}");
    expect(configFingerprint(path)).toBe(configFingerprint(path));
  });

  test("an edit changes the fingerprint", () => {
    writeFileSync(path, "export default {}");
    const before = configFingerprint(path);
    writeFileSync(path, "export default { engine: { source: 'local' } }");
    expect(configFingerprint(path)).not.toBe(before);
  });

  test("a same-size rewrite is still caught (mtime moves even when size does not)", () => {
    const stat = (() => {
      let mtimeMs = 1;
      return () => ({ mtimeMs: mtimeMs++, size: 10 });
    })();
    expect(configFingerprint(path, stat)).not.toBe(configFingerprint(path, stat));
  });

  test("a missing file fingerprints as null rather than throwing", () => {
    expect(configFingerprint(join(dir, "gone.ts"))).toBeNull();
  });
});
