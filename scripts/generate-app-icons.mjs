/**
 * Generates the home-screen icons for the route-scoped admin and staff apps.
 *
 * The only logo committed to this repo is favicon.ico, whose largest frame is
 * 64x64 — far too small to upscale to a 512px app icon. So the mark is drawn
 * procedurally at native resolution instead: the brand's grapefruit slice on a
 * solid brand background, one colour per app so the two are distinguishable at
 * a glance on a home screen.
 *
 * Dependency-free (node:zlib only). Re-run with:
 *   node scripts/generate-app-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "public", "icons");

/** Brand palette (see client/src/index.css and server/emails.ts). */
const CREAM = [253, 248, 243];
const FLESH = [255, 214, 202];
const APPS = {
  admin: { bg: [242, 109, 91] }, // primary coral
  staff: { bg: [46, 110, 91] }, // secondary deep green
};

/** Icon sizes every install target needs: apple-touch, and the two manifest sizes. */
const SIZES = [180, 192, 512];

// ---------------------------------------------------------------------------
// Minimal PNG encoder
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes an RGB pixel buffer (3 bytes/px, no alpha — icons are full-bleed). */
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark: a grapefruit slice, supersampled for clean edges
// ---------------------------------------------------------------------------

const SS = 3; // supersample factor
const WEDGES = 8;

/** Colour of a single (supersampled) sample point. */
function sampleAt(x, y, size, bg, radius) {
  const cx = size / 2;
  const cy = size / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);

  if (dist > radius) return bg;
  // Rind: outer band.
  if (dist > radius * 0.87) return CREAM;
  // Pith: thin ring inside the rind.
  if (dist > radius * 0.82) return FLESH;
  // Centre pith dot.
  if (dist < radius * 0.09) return CREAM;

  // Wedge separators: cream spokes at even angular intervals.
  const angle = Math.atan2(dy, dx) + Math.PI * 2;
  const step = (Math.PI * 2) / WEDGES;
  const offset = Math.abs(((angle % step) + step) % step) - step / 2;
  // Constant-width spokes: widen the angular gap as we approach the centre.
  const halfGap = Math.min(0.16, (radius * 0.022) / Math.max(dist, 1e-6));
  if (Math.abs(offset) < halfGap) return CREAM;

  return FLESH;
}

/** Renders one icon: full-bleed background with the slice centred. */
function renderIcon(size, bg, markScale) {
  const radius = size * markScale;
  const out = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sampleAt(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, size, bg, radius);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 3;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [app, { bg }] of Object.entries(APPS)) {
  for (const size of SIZES) {
    writeFileSync(join(OUT_DIR, `${app}-${size}.png`), renderIcon(size, bg, 0.34));
  }
  // Maskable: same mark pulled into the inner 80% safe zone so Android's
  // adaptive-icon crop can never clip it.
  writeFileSync(join(OUT_DIR, `${app}-512-maskable.png`), renderIcon(512, bg, 0.26));
  console.log(`generated ${app}: ${SIZES.join(", ")} + 512 maskable`);
}
