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
// The mark: an olive sprig. Phoebe is named for the deacon of Cenchreae who
// carried Paul's letter to Rome (Romans 16:1-2); the olive branch is the
// messenger's, carried by the dove to say the waters had gone down. It is
// drawn the way the wheat ear in JesusFilm/youtube-studio is: one object in
// one colour, its parts separated by gaps of the tile rather than by outlines,
// so the two marks sit together as siblings. The sprig is drawn off-axis on
// purpose: one curved stem rooted bottom-left and leaning up-right, leaves
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

// Where the stem's base sits on the tile before centring. The measured
// centring below moves the whole mark, so this only has to be roughly right.
const BASE = { x: 90, y: 440 };

/**
 * The mark: the stem is one quadratic curve from the base, bending up and to
 * the right; each leaf sits at a fraction `t` along it, splayed off the
 * tangent there. Stroke paths are the stem; the rest are filled.
 */
function buildMark() {
  const p0 = BASE;
  const p1 = { x: p0.x + 115, y: p0.y - 198 };
  const p2 = { x: p0.x + 264, y: p0.y - 380 };
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
    [0.18, -1, 80, 38, 52],
    [0.3, 1, 70, 34, 46],
    [0.46, -1, 77, 37, 50],
    [0.6, 1, 62, 31, 44],
    [0.76, -1, 66, 32, 48],
    [0.9, 1, 52, 26, 40],
  ];
  for (const [t, side, halfLength, halfWidth, splay] of leaves) {
    const p = at(t);
    const angle = tangentAt(t) + side * deg(splay);
    // Push the leaf outward so its inner tip sits on the stem.
    const cx = p.x + (halfLength - 8) * Math.cos(angle);
    const cy = p.y + (halfLength - 8) * Math.sin(angle);
    paths.push({ d: leaf(cx, cy, angle, halfLength, halfWidth) });
  }

  // Two olives on the inside of the bend, near the base.
  for (const [t, dist, r] of [
    [0.07, 58, 24],
    [0.16, 96, 20],
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

/**
 * The paths as SVG elements. The stem is a stroke in the mark colour; every
 * leaf and olive is filled in it and outlined in the gap colour, painted under
 * the fill, so where one lies over the stem or a neighbour a gap of the tile
 * shows between them.
 */
function markBody(fill, gap, indent) {
  return buildMark()
    .map((p) =>
      p.stroke
        ? `${indent}<path d="${p.d}" fill="none" stroke="${fill}" stroke-width="38" stroke-linecap="round"/>`
        : `${indent}<path d="${p.d}" fill="${fill}" stroke="${gap}" stroke-width="12" stroke-linejoin="round" paint-order="stroke"/>`,
    )
    .join("\n");
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
 * The mark alone, no tile, for any background: the sprig in one colour, with
 * the gaps between its parts cut through to transparency by a mask.
 */
function buildMarkSvg(box, colour) {
  const pad = 4;
  const x = Math.floor(box.left - pad);
  const y = Math.floor(box.top - pad);
  const w = Math.ceil(box.right + pad) - x;
  const h = Math.ceil(box.bottom + pad) - y;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">
  <title>Phoebe</title>
  <mask id="sprig" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">
${markBody("#fff", "#000", "    ")}
  </mask>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colour}" mask="url(#sprig)"/>
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
