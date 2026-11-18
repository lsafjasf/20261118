// H.264/AVC bitstream helpers: avcC parsing and AVCC -> Annex B conversion.

const START_CODE = new Uint8Array([0, 0, 0, 1]);

export function parseAvcC(u8, offset, length) {
  const p = offset;
  const configurationVersion = u8[p];
  const avcProfileIndication = u8[p + 1];
  const profileCompatibility = u8[p + 2];
  const avcLevelIndication = u8[p + 3];
  const lengthSizeMinusOne = u8[p + 4] & 0x03;

  let cursor = p + 5;
  const sps = [];
  const spsCount = u8[cursor] & 0x1f;
  cursor += 1;
  for (let i = 0; i < spsCount; i += 1) {
    const nalLength = (u8[cursor] << 8) | u8[cursor + 1];
    cursor += 2;
    sps.push(u8.slice(cursor, cursor + nalLength));
    cursor += nalLength;
  }
  const ppsCount = u8[cursor];
  cursor += 1;
  const pps = [];
  for (let i = 0; i < ppsCount; i += 1) {
    const nalLength = (u8[cursor] << 8) | u8[cursor + 1];
    cursor += 2;
    pps.push(u8.slice(cursor, cursor + nalLength));
    cursor += nalLength;
  }

  const profileHex = avcProfileIndication.toString(16).padStart(2, '0');
  const compatHex = profileCompatibility.toString(16).padStart(2, '0');
  const levelHex = avcLevelIndication.toString(16).padStart(2, '0');
  const codec = `avc1.${profileHex}${compatHex}${levelHex}`;

  return {
    configurationVersion,
    lengthSizeMinusOne,
    nalLengthSize: lengthSizeMinusOne + 1,
    sps,
    pps,
    codec,
    parameterSetSize: length - (cursor - p),
  };
}

export function nalType(nalUnit) {
  return nalUnit[0] & 0x1f;
}

// Convert one sample (length-prefixed NAL units) into Annex B bytes.
export function avccToAnnexB(sampleBytes, nalLengthSize) {
  const pieces = [];
  let total = 0;
  let cursor = 0;
  while (cursor + nalLengthSize <= sampleBytes.length) {
    let nalLength = 0;
    for (let i = 0; i < nalLengthSize; i += 1) {
      nalLength = (nalLength << 8) | sampleBytes[cursor + i];
    }
    cursor += nalLengthSize;
    if (nalLength <= 0 || cursor + nalLength > sampleBytes.length) break;
    const nal = sampleBytes.subarray(cursor, cursor + nalLength);
    pieces.push(START_CODE, nal);
    total += START_CODE.length + nalLength;
    cursor += nalLength;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const piece of pieces) {
    out.set(piece, pos);
    pos += piece.length;
  }
  return out;
}

export function buildAnnexBKeyframe(avcCConfig, sampleBytes) {
  const pieces = [];
  let total = 0;
  const push = (bytes) => {
    pieces.push(START_CODE, bytes);
    total += START_CODE.length + bytes.length;
  };
  for (const sps of avcCConfig.sps) push(sps);
  for (const pps of avcCConfig.pps) push(pps);
  const body = avccToAnnexB(sampleBytes, avcCConfig.nalLengthSize);
  const out = new Uint8Array(total + body.length);
  let pos = 0;
  for (const piece of pieces) {
    out.set(piece, pos);
    pos += piece.length;
  }
  out.set(body, pos);
  return out;
}
