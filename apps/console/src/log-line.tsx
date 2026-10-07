// One log line on the console, drawn on its theme (console-themes.ts).
//
// The engine tags every line with where it came from (logs-channels.ts), and
// the tags are what a reader scans for, so each is coloured by its role: the
// bootstrapper's `[phoebe]`, a pipeline's `[phoebe:owner/repo:pipeline]`, the
// unit it is on `[issue 497]`, an agent's `[owner/repo:claude]`, and a
// `:stderr` suffix. The message after the tags is drawn as it came, with any
// ANSI colour an agent put in it (ansi.ts) shown in the theme's palette.

import type { CSSProperties } from "react";
import { parseAnsi, type AnsiSegment, type AnsiStyle } from "./ansi.ts";
import { type AnsiPalette } from "./console-themes.ts";

/** A tag at the head of a line and what it is. */
export type Tag = {
  text: string;
  role: "boot" | "pipeline" | "unit" | "agent" | "stderr";
};

const PIPELINE_TAG = /^\[phoebe:[^\]:]+:[^\]]+\]/;
const BOOT_TAG = /^\[phoebe\]/;
const AGENT_TAG = /^\[[^\]:]+\/[^\]:]+:[^\]]+\]/;
const UNIT_TAG = /^\[[^\]]+\]/;

/** The tags at the head of a line, in order, and the message after them. */
export function splitTags(line: string): { tags: Tag[]; rest: string } {
  const tags: Tag[] = [];
  let rest = line;
  const take = (match: RegExpExecArray | null, role: Tag["role"]): boolean => {
    if (match === null) return false;
    tags.push({ text: match[0], role });
    rest = rest.slice(match[0].length);
    return true;
  };
  if (take(PIPELINE_TAG.exec(rest), "pipeline")) {
    // A pipeline line may say which unit it is on behalf of.
    take(UNIT_TAG.exec(rest), "unit");
  } else if (take(BOOT_TAG.exec(rest), "boot")) {
    // Nothing more: the bootstrapper's lines carry one tag.
  } else if (take(AGENT_TAG.exec(rest), "agent")) {
    const stderr = tags[tags.length - 1]!;
    if (stderr.text.endsWith(":stderr]")) stderr.role = "stderr";
  }
  return { tags, rest };
}

/** The inline style one ANSI run needs, in this palette. */
export function ansiStyleFor(style: AnsiStyle, palette: AnsiPalette): CSSProperties | undefined {
  const css: CSSProperties = {};
  const colour = (value: number | string | null): string | undefined =>
    value === null ? undefined : typeof value === "number" ? palette[value] : value;
  const fg = colour(style.fg);
  const bg = colour(style.bg);
  if (fg !== undefined) css.color = fg;
  if (bg !== undefined) css.backgroundColor = bg;
  if (style.bold) css.fontWeight = 600;
  if (style.dim) css.opacity = 0.7;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = "underline";
  return Object.keys(css).length === 0 ? undefined : css;
}

export function LogLine({ line, palette }: { line: string; palette: AnsiPalette }) {
  const { tags, rest } = splitTags(line);
  const runs: AnsiSegment[] = parseAnsi(rest);
  return (
    <span className="log-line">
      {tags.map((tag, index) => (
        <span key={index} className={`log-tag ${tag.role}`}>
          {tag.text}
        </span>
      ))}
      {runs.map((run, index) => {
        const style = ansiStyleFor(run.style, palette);
        return style === undefined ? (
          <span key={index}>{run.text}</span>
        ) : (
          <span key={index} style={style}>
            {run.text}
          </span>
        );
      })}
      {"\n"}
    </span>
  );
}
