// ANSI escape codes in a log line, read the way a terminal reads them.
//
// An agent's own output can carry colour: `\x1b[31m` and friends, the SGR
// (select graphic rendition) codes. The console draws them in the theme's
// ANSI palette (console-themes.ts) rather than showing the codes or throwing
// them away. Everything else an escape sequence can say — moving the cursor,
// clearing the screen, a terminal title — has no meaning on a page and is
// dropped. The text between codes is never changed.

/** How one run of text is drawn. Colours are palette indexes or exact values. */
export type AnsiStyle = {
  /** An index into the sixteen-colour palette, an exact `rgb(…)`, or null for the default. */
  fg: number | string | null;
  bg: number | string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

export const PLAIN: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

/** Whether the line carries any escape code at all: the common case does not. */
export function hasAnsi(text: string): boolean {
  return text.includes(ESC);
}

// ESC [ … final-byte (CSI), ESC ] … BEL|ST (OSC), or ESC + one byte. Built from
// a string because the pattern is control characters, which a literal may not
// spell out.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ESCAPE = new RegExp(
  `${ESC}(?:\\[([0-9;?]*)([@-~])|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|.)`,
  "g",
);

/** Split a line into styled runs. A line with no codes is one plain run. */
export function parseAnsi(text: string): AnsiSegment[] {
  if (!hasAnsi(text)) return text.length === 0 ? [] : [{ text, style: PLAIN }];
  const segments: AnsiSegment[] = [];
  let style = PLAIN;
  let last = 0;
  const push = (end: number): void => {
    if (end > last) segments.push({ text: text.slice(last, end), style });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(match.index);
    last = match.index + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
  }
  push(text.length);
  return segments;
}

/** One SGR parameter list applied to a style. Unknown codes leave it as it was. */
export function applySgr(style: AnsiStyle, parameters: string): AnsiStyle {
  const codes = parameters === "" ? [0] : parameters.split(";").map((code) => Number(code));
  let next = { ...style };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i] as number;
    if (Number.isNaN(code)) continue;
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const [colour, used] = extended(codes, i + 1);
      if (colour !== null) {
        if (code === 38) next.fg = colour;
        else next.bg = colour;
      }
      i += used;
    }
  }
  return next;
}

/** `38;5;n` and `38;2;r;g;b`: the colour and how many parameters it took. */
function extended(codes: number[], at: number): [number | string | null, number] {
  const mode = codes[at];
  if (mode === 5) {
    const index = codes[at + 1];
    if (index === undefined || Number.isNaN(index)) return [null, 1];
    return [index < 16 ? index : xterm256(index), 2];
  }
  if (mode === 2) {
    const [r, g, b] = [codes[at + 1], codes[at + 2], codes[at + 3]];
    if (r === undefined || g === undefined || b === undefined) return [null, 1];
    return [`rgb(${r}, ${g}, ${b})`, 4];
  }
  return [null, 0];
}

/** The 256-colour cube and greys above the sixteen, as xterm lays them out. */
function xterm256(index: number): string {
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;
    return `rgb(${grey}, ${grey}, ${grey})`;
  }
  const n = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const r = levels[Math.floor(n / 36) % 6];
  const g = levels[Math.floor(n / 6) % 6];
  const b = levels[n % 6];
  return `rgb(${r}, ${g}, ${b})`;
}
