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

function distanceToSegment(x, y, startX, startY, endX, endY) {
  const lineX = endX - startX;
  const lineY = endY - startY;
  const lengthSquared = lineX * lineX + lineY * lineY;
  const projection = Math.max(
    0,
    Math.min(1, ((x - startX) * lineX + (y - startY) * lineY) / lengthSquared),
  );
  return Math.hypot(x - (startX + projection * lineX), y - (startY + projection * lineY));
}

function angleBetween(angle, start, end) {
  const full = Math.PI * 2;
  const normalized = ((angle % full) + full) % full;
  return normalized >= start && normalized <= end;
}

// The 18px asset is the file embedded in the binary. Sampling each output pixel
// on a 4×4 grid keeps the two-ring gauge legible instead of turning its diagonal
// needle and tiny markers into staircase-shaped blobs on a Retina menu bar.
function gaugePixels(size) {
  const samples = 4;
  const stroke = 0.07;
  const upperStart = (Math.PI * 13) / 12;
  const upperEnd = (Math.PI * 23) / 12;
  const lowerStart = Math.PI / 12;
  const lowerEnd = (Math.PI * 11) / 12;

  function covers(x, y) {
    const distance = Math.hypot(x, y);
    const angle = Math.atan2(y, x);
    const onArc = [0.68, 0.83].some(
      (radius) =>
        Math.abs(distance - radius) <= stroke / 2 &&
        (angleBetween(angle, upperStart, upperEnd) || angleBetween(angle, lowerStart, lowerEnd)),
    );

    const pivotX = 0;
    const pivotY = 0.06;
    const onPivot = Math.abs(Math.hypot(x - pivotX, y - pivotY) - 0.12) <= stroke / 2;
    const onNeedle =
      distanceToSegment(x, y, 0.08, 0.02, 0.53, -0.48) <= stroke / 2 ||
      distanceToSegment(x, y, 0.16, 0.11, 0.53, -0.48) <= stroke / 2;
    const onMarker = [-0.39, 0.39].some(
      (markerX) => Math.abs(Math.hypot(x - markerX, y - 0.48) - 0.075) <= stroke / 2,
    );
    return onArc || onPivot || onNeedle || onMarker;
  }

  return (y, x) => {
    let covered = 0;
    for (let sampleY = 0; sampleY < samples; sampleY += 1) {
      for (let sampleX = 0; sampleX < samples; sampleX += 1) {
        const normalizedX = ((x + (sampleX + 0.5) / samples) / size - 0.5) * 2;
        const normalizedY = ((y + (sampleY + 0.5) / samples) / size - 0.5) * 2;
        if (covers(normalizedX, normalizedY)) covered += 1;
      }
    }
    return [0, 0, 0, Math.round((covered / (samples * samples)) * 255)];
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
