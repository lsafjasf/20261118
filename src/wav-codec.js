// Minimal RIFF WAVE reader/writer for the mono 48 kHz demo.
// Supports reading PCM 16/24/32-bit and IEEE float 32/64-bit, mono or stereo
// (stereo is down-mixed to mono). Writes 16-bit PCM or 32-bit float mono.
'use strict';

function readAscii(view, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

function decodeWav(buffer) {
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataLength = 0;
  while (off + 8 <= view.buffer.byteLength) {
    const id = readAscii(view, off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !dataOffset) throw new Error('WAV missing fmt/data chunks');

  const { format, channels, sampleRate, bitsPerSample } = fmt;
  const frameCount = Math.floor(dataLength / channels / (bitsPerSample / 8));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOffset + (i * channels + c) * (bitsPerSample / 8);
      acc += readSample(view, p, format, bitsPerSample);
    }
    samples[i] = acc / channels;
  }
  return { sampleRate, channels, samples };
}

function readSample(view, p, format, bits) {
  if (format === 3) {
    // IEEE float
    if (bits === 32) return view.getFloat32(p, true);
    if (bits === 64) return view.getFloat64(p, true);
  }
  if (format === 1 || format === 0xfffe) {
    if (bits === 16) return view.getInt16(p, true) / 32768;
    if (bits === 32) return view.getInt32(p, true) / 2147483648;
    if (bits === 24) {
      const lo = view.getUint16(p, true);
      const hi = view.getInt8(p + 2);
      return ((hi << 16) | lo) / 8388608;
    }
    if (bits === 8) return (view.getUint8(p) - 128) / 128;
  }
  throw new Error(`unsupported WAV format=${format} bits=${bits}`);
}

function encodeWavPcm16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  writeHeader(buf, 1, sampleRate, 16, dataBytes);
  const view = new DataView(buf.buffer, buf.byteOffset);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return buf;
}

function encodeWavFloat32(samples, sampleRate) {
  const dataBytes = samples.length * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  writeHeader(buf, 3, sampleRate, 32, dataBytes);
  const view = new DataView(buf.buffer, buf.byteOffset);
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(44 + i * 4, samples[i], true);
  }
  return buf;
}

function writeHeader(buf, format, sampleRate, bits, dataBytes) {
  const view = new DataView(buf.buffer, buf.byteOffset);
  const bytesPerSec = sampleRate * (bits / 8);
  buf.write('RIFF', 0, 'ascii');
  view.setUint32(4, 36 + dataBytes, true);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, bytesPerSec, true);
  view.setUint16(32, bits / 8, true);
  view.setUint16(34, bits, true);
  buf.write('data', 36, 'ascii');
  view.setUint32(40, dataBytes, true);
}

module.exports = { decodeWav, encodeWavPcm16, encodeWavFloat32 };
