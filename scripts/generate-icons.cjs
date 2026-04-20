#!/usr/bin/env node
/**
 * Generate placeholder PWA icons for LanguageTracker.
 * Run: node scripts/generate-icons.js
 * Output: public/icon-192.png, public/icon-512.png
 *
 * To replace with real icons: drop new files into /public with the same names.
 * No code changes needed — manifest.json just references the paths.
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ─────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.alloc(4);
  const crcBuf  = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Letter bitmaps (5 wide × 7 tall, 1 = filled) ─────────────────────────────

const LETTER_L = [
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,1,1,1,1],
];

const LETTER_T = [
  [1,1,1,1,1],
  [0,0,1,0,0],
  [0,0,1,0,0],
  [0,0,1,0,0],
  [0,0,1,0,0],
  [0,0,1,0,0],
  [0,0,1,0,0],
];

// ── Icon generator ────────────────────────────────────────────────────────────

function generatePNG(size) {
  const scale   = Math.max(1, Math.round(size / 16));
  const letterW = 5 * scale;
  const letterH = 7 * scale;
  const gap     = scale * 2;
  const totalW  = letterW + gap + letterW;
  const startX  = Math.floor((size - totalW) / 2);
  const startY  = Math.floor((size - letterH) / 2);

  const BG = [0x11, 0x11, 0x11]; // #111111
  const FG = [0xFF, 0xFF, 0xFF]; // #ffffff

  // RGB pixel buffer initialised to background colour
  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3]     = BG[0];
    pixels[i * 3 + 1] = BG[1];
    pixels[i * 3 + 2] = BG[2];
  }

  function setPixel(x, y) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 3;
    pixels[i]     = FG[0];
    pixels[i + 1] = FG[1];
    pixels[i + 2] = FG[2];
  }

  function drawLetter(bitmap, ox, oy) {
    for (let row = 0; row < bitmap.length; row++) {
      for (let col = 0; col < bitmap[row].length; col++) {
        if (!bitmap[row][col]) continue;
        for (let py = 0; py < scale; py++)
          for (let px = 0; px < scale; px++)
            setPixel(ox + col * scale + px, oy + row * scale + py);
      }
    }
  }

  drawLetter(LETTER_L, startX, startY);
  drawLetter(LETTER_T, startX + letterW + gap, startY);

  // Raw scanlines: filter byte (0 = None) + RGB row
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter: None
    pixels.copy(row, 1, y * size * 3, (y + 1) * size * 3);
    rows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level: 6 });

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // colour type: RGB
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write icons ───────────────────────────────────────────────────────────────

const OUT_DIR = path.join(__dirname, '..', 'public');

fs.writeFileSync(path.join(OUT_DIR, 'icon-192.png'), generatePNG(192));
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), generatePNG(512));
console.log('Generated: public/icon-192.png, public/icon-512.png');
