import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function sdistRoundedBox(px: number, py: number, cx: number, cy: number, hw: number, hh: number, radius: number): number {
  const dx = Math.max(Math.abs(px - cx) - (hw - radius), 0);
  const dy = Math.max(Math.abs(py - cy) - (hh - radius), 0);
  return Math.hypot(dx, dy) - radius;
}

/** Renders the Research Buddy robot icon at `size × size` as a valid RGBA PNG buffer. */
export function renderBotPng(size = 32): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const scale = size / 512;

  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter: None
    const py = (y + 0.5) / scale;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / scale;
      let r = 0, g = 0, b = 0, a = 0;

      // Outer rounded tile (#171f32 with #4c6379 border)
      const tileDist = sdistRoundedBox(px, py, 256, 256, 228, 228, 128);
      if (tileDist < 1.5) {
        const coverage = Math.max(0, Math.min(1, 0.5 - tileDist * scale));
        const border = Math.abs(tileDist + 4) < 5;
        r = border ? 0x4c : 0x17;
        g = border ? 0x63 : 0x1f;
        b = border ? 0x79 : 0x32;
        a = Math.round(coverage * 255);

        // Antenna stem & tip (#b8f5db)
        const stem = Math.abs(px - 256) <= 9 && py >= 106 && py <= 160;
        const tipDist = Math.hypot(px - 256, py - 98) - 22;
        if (stem || tipDist <= 0) {
          r = 0xb8; g = 0xf5; b = 0xdb; a = 255;
        }

        // Robot head (#233d48 fill, #b4f5dd stroke)
        const headDist = sdistRoundedBox(px, py, 256, 276, 152, 108, 62);
        if (headDist <= 0) {
          if (headDist > -14) {
            r = 0xb4; g = 0xf5; b = 0xdd; a = 255;
          } else {
            r = 0x23; g = 0x3d; b = 0x48; a = 255;
            // Eyes (#b8f5db)
            const leftEye = sdistRoundedBox(px, py, 210, 276, 18, 28, 16);
            const rightEye = sdistRoundedBox(px, py, 302, 276, 18, 28, 16);
            if (leftEye <= 0 || rightEye <= 0) {
              r = 0xb8; g = 0xf5; b = 0xdb; a = 255;
            }
          }
        }
      }

      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
