// Builds Phoebe's icon: writes assets/icon/phoebe.svg from the geometry below,
// renders every PNG size with Electron's own Chromium, then packs phoebe.ico
// and phoebe.icns. Both container formats are a header around plain PNG
// frames, so no image library is involved, and Electron is already a dev
// dependency here, so no browser is downloaded for the job.
//
//   vp run build-icon        (or: node scripts/build-icon.mjs)
//
// Run under plain Node, the script relaunches itself inside Electron. Run under
// Electron, it renders. `ELECTRON_RUN_AS_NODE` is cleared for the relaunch,
// because some agent harnesses set it and it would turn the relaunch back into
// Node.
//
// The mark: a wax seal pressed with an olive sprig. Phoebe is named for the
// deacon of Cenchreae who carried Paul's letter to Rome (Romans 16:1-2), and a
// seal is what a letter carried by hand bore. The sprig is cut out of the seal
// in the tile colour, the way the wheat ear in JesusFilm/youtube-studio has
// its kernels separated by gaps of the tile, so the two marks sit together as
// siblings. The sprig is drawn off-axis on purpose: one curved stem, leaves
// alternating sides at uneven intervals and lengths, two olives at the base.
//
// The mark's painted bounding box is measured in Chromium and translated to
// the tile's centre, so the geometry can change without the centring going
// stale.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import electron from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../assets/icon");
const consolePublicDir = path.resolve(here, "../../console/public");

const SIZE = 512;
const TILE = "#0F766E";
const MARK = "#D9FBEE";
const CORNER = Math.round(SIZE * 0.22);

// ---- geometry -------------------------------------------------------------

const deg = (d) => (d * Math.PI) / 180;
const fmt = (n) => Math.round(n * 10) / 10;

/** The seal: a disc with a scalloped edge, `n` bumps around it. */
function sealPath() {
  const n = 10;
  const inner = 158;
  const outer = 176;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const a0 = deg((i * 360) / n);
    const a1 = deg(((i + 0.5) * 360) / n);
    const a2 = deg(((i + 1) * 360) / n);
    const p0 = [cx + inner * Math.cos(a0), cy + inner * Math.sin(a0)];
    const c = [cx + (outer + 24) * Math.cos(a1), cy + (outer + 24) * Math.sin(a1)];
    const p2 = [cx + inner * Math.cos(a2), cy + inner * Math.sin(a2)];
    if (i === 0) d += `M ${fmt(p0[0])} ${fmt(p0[1])} `;
    d += `Q ${fmt(c[0])} ${fmt(c[1])} ${fmt(p2[0])} ${fmt(p2[1])} `;
  }
  return `${d}Z`;
}

/** An almond-shaped leaf centred on (cx, cy), its long axis at `angle`. */
function leaf(cx, cy, angle, halfLength, halfWidth) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const pt = (x, y) => `${fmt(cx + x * c - y * s)} ${fmt(cy + x * s + y * c)}`;
  return [
    `M ${pt(-halfLength, 0)}`,
    `Q ${pt(0, -halfWidth * 2)} ${pt(halfLength, 0)}`,
    `Q ${pt(0, halfWidth * 2)} ${pt(-halfLength, 0)}`,
    "Z",
  ].join(" ");
}

/**
 * The sprig, in its own coordinates with the stem's base at the origin. The
 * stem is one quadratic curve bending up and to the right; each leaf sits at a
 * fraction `t` along it, splayed off the tangent there.
 */
function buildSprig() {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 70, y: -120 };
  const p2 = { x: 160, y: -230 };
  const at = (t) => ({
    x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
    y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
  });
  const tangentAt = (t) =>
    Math.atan2(
      2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
      2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    );

  const paths = [];
  paths.push({
    d: `M ${fmt(p0.x)} ${fmt(p0.y)} Q ${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)}`,
    stroke: true,
  });

  // [t along the stem, side, half-length, half-width, splay from the tangent]
  const leaves = [
    [0.18, -1, 46, 19, 52],
    [0.3, 1, 40, 17, 46],
    [0.46, -1, 44, 18, 50],
    [0.6, 1, 36, 15, 44],
    [0.76, -1, 38, 16, 48],
    [0.9, 1, 30, 13, 40],
  ];
  for (const [t, side, halfLength, halfWidth, splay] of leaves) {
    const p = at(t);
    const angle = tangentAt(t) + side * deg(splay);
    // Push the leaf outward so its inner tip sits on the stem.
    const cx = p.x + (halfLength - 4) * Math.cos(angle);
    const cy = p.y + (halfLength - 4) * Math.sin(angle);
    paths.push({ d: leaf(cx, cy, angle, halfLength, halfWidth) });
  }

  // Two olives on the inside of the bend, near the base.
  for (const [t, dist, r] of [
    [0.08, 26, 13],
    [0.14, 48, 11],
  ]) {
    const p = at(t);
    const angle = tangentAt(t) + deg(70);
    const cx = p.x + dist * Math.cos(angle);
    const cy = p.y + dist * Math.sin(angle);
    paths.push({
      d: `M ${fmt(cx - r)} ${fmt(cy)} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`,
    });
  }
  return paths;
}

// Where the sprig's base lands on the tile before centring. The measured
// centring below moves the whole mark, seal and sprig together, so this only
// has to put the sprig roughly over the disc.
const SPRIG_BASE = { x: 169.6, y: 379.7 };

/** The mark's paths in tile coordinates. The seal first, the sprig cut into it. */
function buildMark() {
  return [{ d: sealPath() }, ...buildSprig()];
}

function sprigTransform() {
  return `translate(${fmt(SPRIG_BASE.x)} ${fmt(SPRIG_BASE.y)})`;
}

/** The paths as SVG elements, with the fill/cut colours given. */
function markBody(fill, cut, indent) {
  const [seal, ...sprig] = buildMark();
  const lines = [
    `${indent}<path d="${seal.d}" fill="${fill}" stroke="${cut}" stroke-width="12" stroke-linejoin="round" paint-order="stroke"/>`,
    `${indent}<g transform="${sprigTransform()}">`,
  ];
  for (const p of sprig) {
    lines.push(
      p.stroke
        ? `${indent}  <path d="${p.d}" fill="none" stroke="${cut}" stroke-width="14" stroke-linecap="round"/>`
        : `${indent}  <path d="${p.d}" fill="${cut}"/>`,
    );
  }
  lines.push(`${indent}</g>`);
  return lines.join("\n");
}

function buildSvg(offset = { x: 0, y: 0 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <title>Phoebe</title>
  <rect width="${SIZE}" height="${SIZE}" rx="${CORNER}" fill="${TILE}"/>
  <g transform="translate(${fmt(offset.x)} ${fmt(offset.y)})">
${markBody(MARK, TILE, "    ")}
  </g>
</svg>
`;
}

/**
 * The mark alone, no tile, for any background: the seal in one colour with
 * the sprig cut through to transparency by a mask.
 */
function buildMarkSvg(box, colour) {
  const pad = 4;
  const x = Math.floor(box.left - pad);
  const y = Math.floor(box.top - pad);
  const w = Math.ceil(box.right + pad) - x;
  const h = Math.ceil(box.bottom + pad) - y;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">
  <title>Phoebe</title>
  <mask id="seal" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">
${markBody("#fff", "#000", "    ")}
  </mask>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colour}" mask="url(#seal)"/>
</svg>
`;
}

// ---- rendering ------------------------------------------------------------

const PNG_SIZES = [16, 32, 48, 64, 128, 180, 256, 512];

const page = (body) =>
  `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}</style></head><body>${body}</body></html>`;

async function withWindow(width, height, html, fn) {
  const { BrowserWindow } = electron;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  // A file rather than a data: URL, which the offscreen window refused to load.
  const dir = await mkdtemp(path.join(os.tmpdir(), "phoebe-icon-"));
  const file = path.join(dir, "page.html");
  await writeFile(file, html);
  try {
    await win.loadFile(file);
    // One frame after load, so the offscreen surface has painted.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return await fn(win);
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The painted bounding box of the mark group, stroke included. */
async function measureMark(svg) {
  return withWindow(SIZE, SIZE, page(svg), (win) =>
    win.webContents.executeJavaScript(`(() => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const el of document.querySelectorAll("svg > g path")) {
        const r = el.getBoundingClientRect();
        left = Math.min(left, r.left); top = Math.min(top, r.top);
        right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
      }
      return { left, top, right, bottom };
    })()`),
  );
}

/** The offset that puts a measured box at the tile's centre. */
function centringOffset(box) {
  return {
    x: SIZE / 2 - (box.left + box.right) / 2,
    y: SIZE / 2 - (box.top + box.bottom) / 2,
  };
}

function pngSize(png) {
  // IHDR follows the 8-byte signature and the 4-byte length + "IHDR" type.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function renderPngs(svg) {
  const pngs = new Map();
  for (const size of PNG_SIZES) {
    const scaled = svg.replace(
      `width="${SIZE}" height="${SIZE}"`,
      `width="${size}" height="${size}"`,
    );
    const png = await withWindow(size, size, page(scaled), async (win) => {
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
      return image.toPNG();
    });
    const actual = pngSize(png);
    if (actual.width !== size || actual.height !== size) {
      throw new Error(
        `rendered ${actual.width}x${actual.height} for the ${size} frame; is a display scale factor leaking in?`,
      );
    }
    pngs.set(size, png);
  }
  return pngs;
}

// ---- containers -----------------------------------------------------------

/** ICO: a directory of PNG frames. Windows accepts PNG payloads since Vista. */
function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const dir = [];
  const blobs = [];
  let offset = 6 + 16 * frames.length;
  for (const [size, png] of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dir.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...blobs]);
}

/** ICNS: a sequence of typed PNG chunks under a single header. */
function packIcns(frames) {
  // OSType codes for PNG payloads by pixel size.
  const types = { 16: "icp4", 32: "icp5", 64: "icp6", 128: "ic07", 256: "ic08", 512: "ic09" };
  const chunks = [];
  for (const [size, png] of frames) {
    const type = types[size];
    if (!type) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(8 + png.length, 4);
    chunks.push(head, png);
  }
  const bodyLength = chunks.reduce((n, b) => n + b.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + bodyLength, 4);
  return Buffer.concat([header, ...chunks]);
}

// ---- main -----------------------------------------------------------------

async function build() {
  const { app } = electron;
  // Offscreen frames follow the display's scale factor otherwise, and a 2x
  // display would hand back a 32px bitmap for the 16px frame.
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  await app.whenReady();
  // Each frame gets a window of its own and closes it; without this, Electron
  // takes the first close for the last one and quits the script mid-way.
  app.on("window-all-closed", () => {});

  await mkdir(outDir, { recursive: true });
  await mkdir(consolePublicDir, { recursive: true });

  const box = await measureMark(buildSvg());
  const svg = buildSvg(centringOffset(box));
  const centred = await measureMark(svg);
  await writeFile(path.join(outDir, "phoebe.svg"), svg);
  await writeFile(path.join(outDir, "phoebe-mark.svg"), buildMarkSvg(centred, TILE));
  await writeFile(path.join(outDir, "phoebe-mono.svg"), buildMarkSvg(centred, "#000"));

  const pngs = await renderPngs(svg);
  for (const [size, png] of pngs) {
    await writeFile(path.join(outDir, `phoebe-${size}.png`), png);
  }
  await writeFile(
    path.join(outDir, "phoebe.ico"),
    packIco([16, 32, 48, 256].map((s) => [s, pngs.get(s)])),
  );
  await writeFile(
    path.join(outDir, "phoebe.icns"),
    packIcns([16, 32, 64, 128, 256, 512].map((s) => [s, pngs.get(s)])),
  );

  // The console's favicon set. Vite copies public/ to the bundle root, and the
  // companion serves it from there over the console scheme.
  await writeFile(path.join(consolePublicDir, "favicon.svg"), svg);
  await writeFile(path.join(consolePublicDir, "favicon-32.png"), pngs.get(32));
  await writeFile(path.join(consolePublicDir, "apple-touch-icon.png"), pngs.get(180));

  console.log(`Wrote ${outDir} and ${consolePublicDir}`);
  app.quit();
}

if (process.versions.electron && typeof electron !== "string") {
  build().catch((error) => {
    console.error(error);
    electron.app.exit(1);
  });
} else {
  // Under Node, `electron` resolves to the path of the binary. Relaunch inside it.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 1));
}
