import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

type PngInfo = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compressedPixels: Buffer;
};

function readPng(path: string): PngInfo {
  const source = readFileSync(path);
  expect(source.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.toString('ascii', offset + 4, offset + 8);
    const data = source.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  return { width, height, bitDepth, colorType, compressedPixels: Buffer.concat(idat) };
}

function rgbaPixels(path: string): Buffer {
  const png = readPng(path);
  expect({ bitDepth: png.bitDepth, colorType: png.colorType }).toEqual({ bitDepth: 8, colorType: 6 });
  const encoded = inflateSync(png.compressedPixels);
  const stride = png.width * 4;
  const pixels = Buffer.alloc(stride * png.height);

  for (let y = 0; y < png.height; y += 1) {
    const rowOffset = y * (stride + 1);
    // The deterministic tray generator deliberately writes unfiltered RGBA rows.
    expect(encoded[rowOffset]).toBe(0);
    encoded.copy(pixels, y * stride, rowOffset + 1, rowOffset + 1 + stride);
  }
  return pixels;
}

const obsoleteGeneratedAssets = [
  'assets/brand/agents-usage-monitor-cat-v2.png',
  'assets/brand/agents-usage-monitor-cat-v2.prompt.txt',
  'assets/brand/agents-usage-night-cat-v1.png',
  'assets/brand/agents-usage-night-cat-v1.prompt.txt',
  'assets/brand/agents-usage-outline-cat-v3.png',
  'assets/brand/agents-usage-outline-cat-v3.prompt.txt',
  'assets/icons/agents-usage-monitor-cat-v2.png',
  'assets/icons/agents-usage-outline-cat-v3.png',
  'src-tauri/icons/32x32.png',
  'src-tauri/icons/64x64.png',
  'src-tauri/icons/128x128.png',
  'src-tauri/icons/128x128@2x.png',
  'src-tauri/icons/icon.ico',
  'src-tauri/icons/StoreLogo.png',
  'src-tauri/icons/Square30x30Logo.png',
  'src-tauri/icons/Square44x44Logo.png',
  'src-tauri/icons/Square71x71Logo.png',
  'src-tauri/icons/Square89x89Logo.png',
  'src-tauri/icons/Square107x107Logo.png',
  'src-tauri/icons/Square142x142Logo.png',
  'src-tauri/icons/Square150x150Logo.png',
  'src-tauri/icons/Square284x284Logo.png',
  'src-tauri/icons/Square310x310Logo.png'
];

describe('macOS icon assets', () => {
  it('keeps the canonical source, runtime PNG and macOS icon container', () => {
    const brand = readPng('assets/brand/agents-usage-gauge-v1.png');
    expect({ width: brand.width, height: brand.height }).toEqual({ width: 1024, height: 1024 });

    const runtimeIcon = readPng('src-tauri/icons/icon.png');
    expect({ width: runtimeIcon.width, height: runtimeIcon.height }).toEqual({
      width: 512,
      height: 512
    });

    const icns = readFileSync('src-tauri/icons/icon.icns');
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  it('configures the Unix runtime PNG and macOS package container', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      bundle: { icon: string[] };
    };
    expect(config.bundle.icon).toEqual(['icons/icon.png', 'icons/icon.icns']);
  });

  it.each([
    ['src-tauri/icons/tray-template.png', 18],
    ['src-tauri/icons/tray-template@2x.png', 36]
  ])('%s is a black-and-alpha template at %ipx', (path, size) => {
    const png = readPng(path);
    expect({ width: png.width, height: png.height }).toEqual({ width: size, height: size });

    const pixels = rgbaPixels(path);
    let clear = 0;
    let visible = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const [red, green, blue, alpha] = pixels.subarray(offset, offset + 4);
      expect([red, green, blue]).toEqual([0, 0, 0]);
      if (alpha === 0) clear += 1;
      if (alpha > 0) visible += 1;
    }
    expect(clear).toBeGreaterThan(0);
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(size * size * 0.65);
  });

  it('loads the template icon through the macOS recolouring path', () => {
    const host = readFileSync('src-tauri/src/lib.rs', 'utf8');
    expect(host).toContain('../icons/tray-template.png');
    expect(host).toContain('.icon_as_template(true)');
  });

  it('does not retain superseded generated images', () => {
    expect(obsoleteGeneratedAssets.filter((path) => existsSync(path))).toEqual([]);
  });
});
