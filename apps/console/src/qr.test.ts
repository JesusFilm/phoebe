// The QR encoder (map #690, #695), checked against the standard's own
// invariants rather than a reference picture: the Reed–Solomon codewords are
// the generator's roots' zeros, the format bits satisfy their BCH check, the
// finder patterns and the dark module are where a reader looks for them, and
// the symbol grows with its input.

import { describe, expect, test } from "vite-plus/test";
import {
  encodeQr,
  formatBits,
  gfMultiply,
  qrSvg,
  rsRemainder,
  versionBits,
  versionFor,
} from "./qr.ts";

/** α^i in the QR field, for evaluating a codeword polynomial at a root. */
function alpha(power: number): number {
  let value = 1;
  for (let i = 0; i < power; i++) value = gfMultiply(value, 2);
  return value;
}

/** Horner's rule over GF(256): the polynomial `coefficients` at `x`. */
function evaluate(coefficients: readonly number[], x: number): number {
  let result = 0;
  for (const coefficient of coefficients) result = gfMultiply(result, x) ^ coefficient;
  return result;
}

describe("the field and the error correction", () => {
  test("multiplication has an identity and 2 generates the field", () => {
    expect(gfMultiply(1, 0x53)).toBe(0x53);
    expect(gfMultiply(0, 0x53)).toBe(0);
    const seen = new Set<number>();
    let value = 1;
    for (let i = 0; i < 255; i++) {
      seen.add(value);
      value = gfMultiply(value, 2);
    }
    expect(seen.size).toBe(255);
    expect(value).toBe(1);
  });

  test("data plus its remainder is a codeword with every generator root as a zero", () => {
    const data = [
      0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70,
      0xec,
    ];
    const ec = rsRemainder(data, 10);
    expect(ec).toHaveLength(10);
    const codeword = [...data, ...ec];
    for (let i = 0; i < 10; i++) expect(evaluate(codeword, alpha(i))).toBe(0);
  });
});

describe("the format and version bits", () => {
  test("format bits pass their BCH check once unmasked", () => {
    for (let mask = 0; mask < 8; mask++) {
      const bits = formatBits(mask) ^ 0b101010000010010;
      let remainder = bits;
      for (let i = 14; i >= 10; i--)
        if (remainder & (1 << i)) remainder ^= 0b10100110111 << (i - 10);
      expect(remainder).toBe(0);
      expect((bits >>> 10) & 0b11111).toBe((0b01 << 3) | mask);
    }
    // The standard's own table, for level L and mask 0.
    expect(formatBits(0)).toBe(0b111011111000100);
  });

  test("version bits pass their BCH check", () => {
    for (const version of [7, 8, 9, 10]) {
      const bits = versionBits(version);
      let remainder = bits;
      for (let i = 17; i >= 12; i--)
        if (remainder & (1 << i)) remainder ^= 0b1111100100101 << (i - 12);
      expect(remainder).toBe(0);
      expect(bits >>> 12).toBe(version);
    }
    expect(versionBits(7)).toBe(0b000111110010010100);
  });
});

describe("the symbol", () => {
  const link = "https://youtube-studio.tail4f2c.ts.net/pair#code=ABCD-EFGH-JK12";

  test("picks the smallest version that fits and refuses what does not", () => {
    expect(versionFor(17)).toBe(1);
    expect(versionFor(18)).toBe(2);
    expect(versionFor(271)).toBe(10);
    expect(versionFor(272)).toBeNull();
    expect(encodeQr("x".repeat(300))).toBeNull();
  });

  test("a short text is version 1, 21 modules, with three finders and the dark module", () => {
    const matrix = encodeQr("hello")!;
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(21);
    const m = matrix.modules;
    for (const [cx, cy] of [
      [3, 3],
      [17, 3],
      [3, 17],
    ] as const) {
      // The ring: dark at distance 0, 1 and 3, light at distance 2.
      expect(m[cy]![cx]).toBe(true);
      expect(m[cy]![cx + 1]).toBe(true);
      expect(m[cy]![cx + 2]).toBe(false);
      expect(m[cy]![cx + 3]).toBe(true);
    }
    expect(m[21 - 8]![8]).toBe(true);
    // The timing patterns alternate between the finders.
    for (let i = 8; i < 13; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
  });

  test("the pairing link fits in version 4 and the format bits are the mask's", () => {
    const matrix = encodeQr(link)!;
    expect(matrix.version).toBe(4);
    expect(matrix.size).toBe(33);
    const bits = formatBits(matrix.mask);
    // The copy along the top-left finder, bit 0 at (8, 0).
    for (let i = 0; i <= 5; i++) expect(matrix.modules[i]![8]).toBe(((bits >>> i) & 1) === 1);
    // An alignment pattern sits at (26, 26) in version 4.
    expect(matrix.modules[26]![26]).toBe(true);
    expect(matrix.modules[25]![26]).toBe(false);
  });

  test("different links are different symbols, and the same link is the same symbol", () => {
    const a = encodeQr(link)!;
    const b = encodeQr(link.replace("JK12", "JK13"))!;
    const again = encodeQr(link)!;
    expect(JSON.stringify(a.modules)).not.toBe(JSON.stringify(b.modules));
    expect(JSON.stringify(a.modules)).toBe(JSON.stringify(again.modules));
  });

  test("the SVG draws one rect per dark module inside a quiet zone", () => {
    const matrix = encodeQr("hello")!;
    const svg = qrSvg(matrix, 2);
    const dark = matrix.modules.flat().filter(Boolean).length;
    expect(svg.match(/<rect /g)).toHaveLength(dark + 1);
    expect(svg).toContain(`viewBox="0 0 ${(21 + 8) * 2} ${(21 + 8) * 2}"`);
  });
});
