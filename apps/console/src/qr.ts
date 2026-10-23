// A QR encoder for one thing: the pairing link, drawn on the install tab so a
// phone can scan it (map #690, #695). Byte mode, error-correction level L,
// versions 1 to 10, all eight masks scored — the standard's own algorithm, kept
// small because it has one caller and one input shape. No dependency: the
// console ships nothing it does not have to.
//
// The output is a matrix of booleans; `qrSvg` draws it. Anything over 271
// bytes is refused rather than cut, since a link cut short is a link that
// pairs nothing.

/** Byte-mode capacity at level L, by version. */
const CAPACITY = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271] as const;

/** Error-correction codewords per block and blocks per version, level L. */
const EC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18] as const;
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4] as const;

/** Alignment pattern centres, by version. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 52],
];

/** Total codewords a version holds, from its size and function patterns. */
function totalCodewords(version: number): number {
  const size = version * 4 + 17;
  let modules = size * size - 3 * 64 - 2 * (size - 16) - 31;
  const centres = ALIGNMENT[version]!.length;
  if (centres > 0) modules -= (centres * centres - 3) * 25;
  if (version >= 7) modules -= 36;
  return Math.floor(modules / 8);
}

// ── GF(256) with the QR polynomial ────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

export function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = Array.from({ length: poly.length + 1 }, () => 0);
    for (const [j, coefficient] of poly.entries()) {
      next[j] ^= coefficient;
      next[j + 1] ^= gfMultiply(coefficient, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The Reed–Solomon remainder of `data` against the generator of `degree`. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const remainder = Array.from({ length: degree }, () => 0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (const [j, coefficient] of gen.entries()) {
      if (j === 0) continue;
      remainder[j - 1] ^= gfMultiply(coefficient, factor);
    }
  }
  return remainder;
}

// ── the symbol ────────────────────────────────────────────────────────────

export type QrMatrix = { size: number; modules: boolean[][]; version: number; mask: number };

/** The smallest version that holds `bytes`, or null past the last one. */
export function versionFor(length: number): number | null {
  for (let version = 1; version <= 10; version++) {
    if (length <= CAPACITY[version]!) return version;
  }
  return null;
}

/** The data codewords: mode, count, the bytes, the terminator, padding. */
function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) push(byte, 8);
  const capacity = (totalCodewords(version) - EC_PER_BLOCK[version]! * BLOCKS[version]!) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; words.length * 8 < capacity; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/** Data split into blocks, each with its error correction, then interleaved. */
function interleave(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version]!;
  const ecLength = EC_PER_BLOCK[version]!;
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks) - ecLength;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecLength));
  }
  const out: number[] = [];
  const longest = shortLength + 1;
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecLength; i++) for (const block of ecBlocks) out.push(block[i]!);
  return out;
}

type Grid = { size: number; modules: boolean[][]; reserved: boolean[][] };

function emptyGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    reserved: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
  };
}

function set(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.modules[y]![x] = dark;
  grid.reserved[y]![x] = true;
}

function finder(grid: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      set(grid, x, y, distance !== 2 && distance !== 4);
    }
  }
}

function alignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      set(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** Every function pattern, and the room reserved for format and version bits. */
function functionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    set(grid, 6, i, i % 2 === 0);
    set(grid, i, 6, i % 2 === 0);
  }
  finder(grid, 3, 3);
  finder(grid, size - 4, 3);
  finder(grid, 3, size - 4);
  const centres = ALIGNMENT[version]!;
  for (const cx of centres) {
    for (const cy of centres) {
      const corner =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === centres.at(-1)) ||
        (cy === 6 && cx === centres.at(-1));
      if (!corner) alignment(grid, cx, cy);
    }
  }
  // Format bits, written for real once the mask is chosen; reserved now. Row
  // and column 6 are the timing patterns' and stay theirs.
  for (let i = 0; i < 8; i++) {
    if (i !== 6) {
      set(grid, 8, i, false);
      set(grid, i, 8, false);
    }
    set(grid, size - 1 - i, 8, false);
    set(grid, 8, size - 1 - i, false);
  }
  set(grid, 8, 8, false);
  set(grid, 8, size - 8, true);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      set(grid, Math.floor(i / 3), size - 11 + (i % 3), false);
      set(grid, size - 11 + (i % 3), Math.floor(i / 3), false);
    }
  }
}

/** The BCH remainder the format and version bits carry. */
function bch(value: number, poly: number): number {
  let remainder = value;
  const degree = Math.floor(Math.log2(poly));
  for (let i = 31 - degree; i >= 0; i--) {
    if (remainder & (1 << (i + degree))) remainder ^= poly << i;
  }
  return remainder;
}

/** The 15 format bits for level L and `mask`, masked with the standard's pattern. */
export function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  const remainder = bch(data << 10, 0b10100110111);
  return ((data << 10) | remainder) ^ 0b101010000010010;
}

/** The 18 version bits for `version`, from 7 up. */
export function versionBits(version: number): number {
  return (version << 12) | bch(version << 12, 0b1111100100101);
}

function writeFormat(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  const { size } = grid;
  const at = (i: number): boolean => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(grid, 8, i, at(i));
  set(grid, 8, 7, at(6));
  set(grid, 8, 8, at(7));
  set(grid, 7, 8, at(8));
  for (let i = 9; i < 15; i++) set(grid, 14 - i, 8, at(i));
  for (let i = 0; i < 8; i++) set(grid, size - 1 - i, 8, at(i));
  for (let i = 8; i < 15; i++) set(grid, 8, size - 15 + i, at(i));
  set(grid, 8, size - 8, true);
}

function writeVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  const { size } = grid;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    set(grid, Math.floor(i / 3), size - 11 + (i % 3), dark);
    set(grid, size - 11 + (i % 3), Math.floor(i / 3), dark);
  }
}

/** The codewords, zig-zagged into every module no function pattern holds. */
function writeData(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (grid.reserved[y]![x]) continue;
        const byte = codewords[bit >>> 3] ?? 0;
        grid.modules[y]![x] = ((byte >>> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.reserved[y]![x] && maskBit(mask, x, y)) grid.modules[y]![x] = !grid.modules[y]![x];
    }
  }
}

/** The standard's four penalties, so the mask chosen is the one a reader likes. */
function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;
  const runs = (line: (i: number) => boolean): void => {
    let run = 0;
    let last: boolean | null = null;
    for (let i = 0; i < size; i++) {
      const dark = line(i);
      if (dark === last) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        last = dark;
        run = 1;
      }
    }
  };
  for (let y = 0; y < size; y++) runs((x) => modules[y]![x]!);
  for (let x = 0; x < size; x++) runs((y) => modules[y]![x]!);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = modules[y]![x];
      if (a === modules[y]![x + 1] && a === modules[y + 1]![x] && a === modules[y + 1]![x + 1]) {
        score += 3;
      }
    }
  }
  const finderLike = (line: (i: number) => boolean): void => {
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 11 <= size; i++) {
      const lightBefore = [0, 1, 2, 3].every((k) => !line(i + k));
      const lightAfter = [0, 1, 2, 3].every((k) => !line(i + 7 + k));
      const core = (offset: number): boolean =>
        pattern.every((dark, k) => line(i + offset + k) === dark);
      if ((lightBefore && core(4)) || (lightAfter && core(0))) score += 40;
    }
  };
  for (let y = 0; y < size; y++) finderLike((x) => modules[y]![x]!);
  for (let x = 0; x < size; x++) finderLike((y) => modules[y]![x]!);
  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  score += k * 10;
  return score;
}

/** Encode `text` as UTF-8 bytes into a symbol, or null when it is too long. */
export function encodeQr(text: string): QrMatrix | null {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === null) return null;
  const codewords = interleave(dataCodewords(bytes, version), version);
  const size = version * 4 + 17;
  let best: { mask: number; grid: Grid; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = emptyGrid(size);
    functionPatterns(grid, version);
    writeData(grid, codewords);
    applyMask(grid, mask);
    writeFormat(grid, mask);
    writeVersion(grid, version);
    const score = penalty(grid);
    if (best === null || score < best.score) best = { mask, grid, score };
  }
  return { size, modules: best!.grid.modules, version, mask: best!.mask };
}

/** The symbol as an SVG, one rect per dark module, with the quiet zone. */
export function qrSvg(matrix: QrMatrix, moduleSize = 4): string {
  const quiet = 4;
  const span = (matrix.size + quiet * 2) * moduleSize;
  const rects: string[] = [];
  for (const [y, row] of matrix.modules.entries()) {
    for (const [x, dark] of row.entries()) {
      if (!dark) continue;
      rects.push(
        `<rect x="${(x + quiet) * moduleSize}" y="${(y + quiet) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`,
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${span}" height="${span}" shape-rendering="crispEdges">` +
    `<rect width="${span}" height="${span}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`
  );
}
