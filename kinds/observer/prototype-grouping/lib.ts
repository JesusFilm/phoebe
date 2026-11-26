// PROTOTYPE (#980), throwaway. Shared helpers: a disk cache for `gh` reads
// and small text utilities. Nothing here is engine code.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROTO_DIR = import.meta.dirname;
export const REPO_ROOT = join(PROTO_DIR, "..", "..", "..");
export const CACHE_DIR = join(PROTO_DIR, "cache");
export const REPO_SLUG = "JesusFilm/phoebe";

function cachePath(namespace: string, key: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 20);
  const dir = join(CACHE_DIR, namespace);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.json`);
}

/** Memoise a JSON-able value on disk. `refresh` ignores what is there. */
export function cached<T>(namespace: string, key: unknown, compute: () => T): T {
  const path = cachePath(namespace, key);
  if (existsSync(path) && process.env["PROTO_REFRESH"] !== "1") {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }
  const value = compute();
  writeFileSync(path, JSON.stringify(value));
  return value;
}

/** `gh <args>` stdout, cached on disk by its argv. */
export function gh(args: readonly string[]): string {
  return cached("gh", args, () =>
    execFileSync("gh", [...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

export function ghJson<T>(args: readonly string[]): T {
  return JSON.parse(gh(args)) as T;
}

/** One line, like the engine's `detail`: whitespace folded, capped. */
export function oneLine(text: string, max = 500): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The first paragraph of a body, Markdown and HTML comments stripped. */
export function firstParagraph(text: string, max = 400): string {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  const para = cleaned.split(/\n\s*\n/).find((p) => p.trim() !== "") ?? "";
  return oneLine(para, max);
}

export function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}
