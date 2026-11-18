// Minimal WAV (PCM16/mono or multi-channel) reader/writer, no dependencies.
'use strict';

function readWav(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = dv.getUint32(offset, false);
  const size = dv.getUint32(offset + 4, true);
  const body = offset + 8;
  if (id === 0x666d7420) {
    fmt = {
      audioFormat: dv.getUint16(body, true),
      channels: dv.getUint16(body + 2, true),
      sampleRate: dv.getUint32(body + 4, true),
      bitsPerSample: dv.getUint16(body + 14, true),
    };
  } else if (id === 0x64617461) {
    data = new DataView(buffer, body, size);
  }
  offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
  throw new Error(`unsupported format: ${fmt.audioFormat}/${fmt.bitsPerSample}bit`);
  }
  const frameCount = data.byteLength / (2 * fmt.channels);
  const channels = [];
  for (let c = 0; c < fmt.channels; c++) channels.push(new Float64Array(frameCount));
  for (let i = 0; i < frameCount; i++) {
  for (let c = 0; c < fmt.channels; c++) {
    channels[c][i] = data.getInt16((i * fmt.channels + c) * 2, true) / 32768;
  }
  }
  return { sampleRate: fmt.sampleRate, channels, frameCount };
}

function writeWavPcm16(channels, sampleRate) {
  const frameCount = channels[0].length;
  const ch = channels.length;
  const bytes = frameCount * ch * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buffer);
  const writeStr = (off, s) => {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, bytes, true);
  let off = 44;
  for (let i = 0; i < frameCount; i++) {
  for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, channels[c][i]));
    dv.setInt16(off, Math.round(v * 32767), true);
    off += 2;
  }
  }
  return Buffer.from(buffer);
}

module.exports = { readWav, writeWavPcm16 };
