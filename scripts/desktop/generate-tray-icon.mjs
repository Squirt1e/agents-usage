#!/usr/bin/env node
// Generate the macOS menu bar template icon (black + alpha) as PNG files.
//
// A template icon must be monochrome with an alpha channel: macOS recolours it
// for light/dark menu bars. This draws a small circular usage gauge with a
// radial needle, the same glyph family as the brand icon, at 18pt and 36pt (@2x).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Add a 0 filter byte per row.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixels(y, x);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Draw a circular gauge: an open ring (about 270 degrees) with a needle pointing
// to ~65% of the arc. Returns [r, g, b, a] for pixel (y, x).
function gaugePixels(size) {
  const center = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.34;
  const startAngle = Math.PI * 0.75; // 135 degrees
  const sweep = Math.PI * 1.5; // 270 degrees
  const needle = startAngle + sweep * 0.65;
  const needleLength = outer * 0.72;

  return (y, x) => {
    const dx = x - center;
    const dy = y - center;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let angle = Math.atan2(dy, dx);
    // Normalize to [startAngle, startAngle + 2pi)
    let rel = (angle - startAngle) % (Math.PI * 2);
    if (rel < 0) rel += Math.PI * 2;

    const onRing = dist >= inner && dist <= outer && rel <= sweep;
    const needleDist = dist <= needleLength;
    const needleAngle = Math.abs((rel - needle) % (Math.PI * 2));
    const onNeedle = needleDist && (needleAngle < 0.08 || needleAngle > Math.PI * 2 - 0.08);

    if (onRing || onNeedle) return [0, 0, 0, 255];
    return [0, 0, 0, 0];
  };
}

for (const [name, size] of [
  ['tray-template.png', 18],
  ['tray-template@2x.png', 36],
]) {
  const png = encodePng(size, gaugePixels(size));
  writeFileSync(join(outDir, name), png);
  console.log(`wrote ${name} (${png.length} bytes)`);
}
