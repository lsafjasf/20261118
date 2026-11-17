// Zero-dependency RGB PNG writer used to synthesize deterministic test frames.
import { deflateSync } from 'node:zlib';

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

// rgb: Uint8Array of width*height*3 bytes, row-major.
export function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgb.subarray(y * stride, (y + 1) * stride).forEach((value, index) => {
      raw[y * (stride + 1) + 1 + index] = value;
    });
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Deterministic frame content: chapter identity band + frame-index band so
// tests can visually and numerically confirm which frame each thumbnail is.
export function makeFrameRgb(width, height, chapterIndex, frameInChapter, framesPerChapter) {
  const rgb = new Uint8Array(width * height * 3);
  const bandHeight = Math.max(1, Math.floor(height / 3));
  const chapterShade = Math.round((chapterIndex * 255) / 19);
  const frameShade = Math.round((frameInChapter * 255) / Math.max(1, framesPerChapter - 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (y < bandHeight) {
        rgb[offset] = chapterShade;
        rgb[offset + 1] = 40;
        rgb[offset + 2] = 255 - chapterShade;
      } else if (y < bandHeight * 2) {
        rgb[offset] = 30;
        rgb[offset + 1] = frameShade;
        rgb[offset + 2] = 120;
      } else {
        rgb[offset] = (x / width) * 255;
        rgb[offset + 1] = (y / height) * 255;
        rgb[offset + 2] = 90;
      }
    }
  }
  return rgb;
}
