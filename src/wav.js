function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function encodeFloat32Wav(left, right, sampleRate) {
  const channels = 2;
  const bytesPerSample = 4;
  const frames = left.length;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    view.setFloat32(offset, left[frame], true);
    view.setFloat32(offset + 4, right[frame], true);
    offset += 8;
  }

  return buffer;
}

export function decodeFloat32Wav(buffer) {
  const view = new DataView(buffer);

  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataBytes = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      format = {
        audioFormat: view.getUint16(chunkStart, true),
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        byteRate: view.getUint32(chunkStart + 8, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataBytes = Math.min(chunkSize, view.byteLength - chunkStart);
      break;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!format || dataOffset < 0) {
    throw new Error('WAV is missing fmt or data chunk');
  }
  if (format.audioFormat !== 3 || format.bitsPerSample !== 32) {
    throw new Error('Reference must be 32-bit IEEE float WAV');
  }
  if (format.channels !== 2) {
    throw new Error('Reference must be stereo');
  }

  const frames = Math.floor(dataBytes / format.blockAlign);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let cursor = dataOffset;

  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = view.getFloat32(cursor, true);
    right[frame] = view.getFloat32(cursor + 4, true);
    cursor += format.blockAlign;
  }

  return {
    left,
    right,
    frames,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
  };
}

function readAscii(view, offset, length) {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}
