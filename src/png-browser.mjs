// Browser-side PNG encoder (8-bit RGBA, filter 0, stored deflate blocks).
// Avoids canvas.toBlob so the exported file matches the compositor buffer
// exactly (canvas internals are premultiplied and can round-trip lossily).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function zlibStore(raw) {
  const blocks = Math.ceil(raw.length / 65535) || 1;
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let src = 0;
  let dst = 2;
  while (src < raw.length || (src === 0 && raw.length === 0)) {
    const len = Math.min(65535, raw.length - src);
    const last = src + len >= raw.length ? 1 : 0;
    out[dst] = last;
    view.setUint16(dst + 1, len, true);
    view.setUint16(dst + 3, 0xffff ^ len, true);
    out.set(raw.subarray(src, src + len), dst + 5);
    src += len;
    dst += 5 + len;
    if (raw.length === 0) break;
  }
  view.setUint32(dst, adler32(raw));
  return out;
}

export function encodePngBrowser(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const ih = new DataView(ihdr.buffer);
  ih.setUint32(0, width);
  ih.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStore(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}
