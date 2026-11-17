// Minimal EBML (Matroska/WebM) reader and writer.
// Works with Node Buffer / Uint8Array without any third-party dependency.

export const ID = {
  EBML: 0x1a45dfa3,
  EBML_READ_VERSION: 0x42f7,
  DOC_TYPE: 0x4282,
  DOC_TYPE_READ_VERSION: 0x4285,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  MUXING_APP: 0x4d80,
  WRITING_APP: 0x5741,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
  REFERENCE_BLOCK: 0xfb,
  CRC_32: 0xbf,
  VOID: 0xec,
};

const ID_BYTES_CACHE = new Map();

export function idToBytes(id) {
  const cached = ID_BYTES_CACHE.get(id);
  if (cached) return cached;
  const hex = id.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = Buffer.from(padded, "hex");
  ID_BYTES_CACHE.set(id, bytes);
  return bytes;
}

function vintLength(firstByte) {
  if (firstByte === 0) return 8;
  let len = 1;
  let marker = 0x80;
  while ((firstByte & marker) === 0) {
    marker >>= 1;
    len += 1;
  }
  return len;
}

export function readVint(buf, pos) {
  const len = vintLength(buf[pos]);
  let value = buf[pos] & (0xff >> len);
  let unknown = value === (0xff >> len);
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  if (unknown) value = -1;
  return { value, length: len };
}

export function writeVint(value) {
  if (value < 0) throw new Error("Cannot encode unknown-size vint");
  for (let len = 1; len <= 8; len += 1) {
    const max = 2 ** (7 * len) - 2;
    if (value <= max) {
      const out = Buffer.alloc(len);
      let remaining = value;
      for (let i = len - 1; i >= 0; i -= 1) {
        out[i] = remaining & 0xff;
        remaining = Math.trunc(remaining / 256);
      }
      out[0] = out[0] | (0x80 >> (len - 1));
      return out;
    }
  }
  throw new Error(`VINT value too large: ${value}`);
}

// Parse every element inside [start, end). An element with an unknown size
// consumes the rest of the range (valid for a live WebM Segment/Cluster).
export function parseElements(buf, start, end) {
  const elements = [];
  let pos = start;
  while (pos < end) {
    const idLen = vintLength(buf[pos]);
    if (pos + idLen >= end) break;
    const idBytes = buf.subarray(pos, pos + idLen);
    const id = parseInt(idBytes.toString("hex"), 16);
    const sizeInfo = readVint(buf, pos + idLen);
    const headerLen = idLen + sizeInfo.length;
    const dataStart = pos + headerLen;
    let dataEnd;
    if (sizeInfo.value < 0) {
      dataEnd = end;
    } else {
      dataEnd = dataStart + sizeInfo.value;
      // A recorder crash can leave a partially written master element whose
      // declared size runs past the buffer. Such an element is unusable.
      if (dataEnd > end) {
        elements.truncated = {
          id,
          start,
          headerEnd: dataStart,
          declaredEnd: dataEnd,
          end,
        };
        return elements;
      }
    }
    elements.push({
      id,
      start: pos,
      headerEnd: dataStart,
      end: dataEnd,
      raw: buf.subarray(pos, dataEnd),
      unknownSize: sizeInfo.value < 0,
    });
    pos = dataEnd;
    if (sizeInfo.value < 0) break;
  }
  return elements;
}

export function encodeElement(id, payload) {
  const idBytes = idToBytes(id);
  const sizeBytes = writeVint(payload.length);
  return Buffer.concat([idBytes, sizeBytes, payload]);
}

export function findChild(buf, element, childId) {
  return parseElements(buf, element.headerEnd, element.end).find(
    (child) => child.id === childId,
  );
}

export function readUnsigned(buf, element) {
  let value = 0;
  for (let i = element.headerEnd; i < element.end; i += 1) {
    value = value * 256 + buf[i];
  }
  return value;
}

export function readFloat(buf, element) {
  const body = buf.subarray(element.headerEnd, element.end);
  if (body.length === 4) return body.readFloatBE();
  if (body.length === 8) return body.readDoubleBE();
  throw new Error(`Unsupported float width: ${body.length}`);
}

export function readString(buf, element) {
  return buf.subarray(element.headerEnd, element.end).toString("utf8");
}

// Relative Block/SimpleBlock timecode is a signed int16 right after the
// track-number VINT.
export function readBlockRelativeTime(buf, blockElement) {
  const trackVint = readVint(buf, blockElement.headerEnd);
  const relPos = blockElement.headerEnd + trackVint.length;
  return buf.readInt16BE(relPos);
}

export function readBlockTrackNumber(buf, blockElement) {
  return readVint(buf, blockElement.headerEnd).value;
}
