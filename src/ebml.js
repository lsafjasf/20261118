// Minimal EBML (Matroska/WebM) read + write primitives.
// Only covers the subset needed to parse and build chapter-bearing WebM files.

export const ID = {
  HEADER: 0x1a45dfa3,
  EBML_VERSION: 0x4286,
  EBML_READ_VERSION: 0x42f7,
  EBML_MAX_ID_LENGTH: 0x42f2,
  EBML_MAX_SIZE_LENGTH: 0x42f3,
  DOC_TYPE: 0x4282,
  DOC_TYPE_VERSION: 0x4287,
  DOC_TYPE_READ_VERSION: 0x4285,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  MUXING_APP: 0x4d80,
  WRITING_APP: 0x5741,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_UID: 0x73c5,
  TRACK_TYPE: 0x83,
  FLAG_LACING: 0x9c,
  CODEC_ID: 0x86,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  CLUSTER: 0x1f43b675,
  TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  CHAPTERS: 0x1043a770,
  EDITION_ENTRY: 0x45b9,
  EDITION_FLAG_DEFAULT: 0x45db,
  CHAPTER_ATOM: 0xb6,
  CHAPTER_UID: 0x73c4,
  CHAPTER_TIME_START: 0x91,
  CHAPTER_TIME_END: 0x92,
  CHAPTER_FLAG_HIDDEN: 0x98,
  CHAPTER_FLAG_ENABLED: 0xb9,
  DISPLAY_META: 0x80,
  CHAP_STRING: 0x85,
  CHAP_LANG: 0x437c,
  CUES: 0x1c53bb6b
};

// Read an EBML variable-length integer. Returns { value, length }.
// When keepMarker is true the leading marker bit stays in the value.
export function readVint(bytes, offset, keepMarker = false) {
  const first = bytes[offset];
  if (first === 0) throw new Error('Invalid EBML vint: reserved all-zero octet');
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('Invalid EBML vint length');
  let value = keepMarker ? first : first ^ (0x80 >> (len - 1));
  for (let i = 1; i < len; i++) value = value * 256 + bytes[offset + i];
  return { value, length: len };
}

// Smallest-length encoding of a non-negative integer as an EBML vint.
export function writeVint(value, forceLength = 0) {
  if (forceLength > 0) {
    const out = new Uint8Array(forceLength);
    let v = value;
    for (let i = forceLength - 1; i >= 0; i--) {
      out[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    out[0] |= 0x80 >> (forceLength - 1);
    return out;
  }
  let len = 1;
  let max = 0x7f; // 7 usable bits at length 1
  while (value > max && len < 8) {
    len++;
    max = max * 256 + 0xff;
  }
  return writeVint(value, len);
}

export function encodeUint(value) {
  if (value < 0 || !Number.isSafeInteger(value)) throw new Error('uint out of range');
  if (value === 0) return new Uint8Array(0);
  const bytes = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(bytes);
}

export function encodeFloat64(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return new Uint8Array(buf);
}

export function encodeString(str) {
  return new TextEncoder().encode(str);
}

// Encode an element id using its canonical fixed width.
export function encodeId(id) {
  const bytes = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(bytes);
}

export function element(id, payload) {
  const idBytes = encodeId(id);
  const sizeBytes = writeVint(payload.length);
  const out = new Uint8Array(idBytes.length + sizeBytes.length + payload.length);
  out.set(idBytes, 0);
  out.set(sizeBytes, idBytes.length);
  out.set(payload, idBytes.length + sizeBytes.length);
  return out;
}

export function uintElement(id, value) {
  return element(id, encodeUint(value));
}

export function stringElement(id, str) {
  return element(id, encodeString(str));
}

export function floatElement(id, value) {
  return element(id, encodeFloat64(value));
}

export function concat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Walk direct-child elements of a master element payload.
export function* children(bytes, start, end) {
  let offset = start;
  while (offset < end) {
    // Element IDs keep their marker bit(s): determine length from the leading
    // octet but read the raw bytes unchanged.
    const first = bytes[offset];
    let idLen = 1;
    while (!(first & (0x80 >> (idLen - 1)))) idLen++;
    if (idLen > 4) throw new Error('Invalid EBML element id length');
    let idValue = 0;
    for (let i = 0; i < idLen; i++) idValue = idValue * 256 + bytes[offset + i];
    const id = { value: idValue, length: idLen };
    const size = readVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    yield {
      id: id.value,
      start: dataStart,
      end: dataStart + size.value,
      headerEnd: dataStart
    };
    offset = dataStart + size.value;
  }
}

export function findChild(bytes, start, end, wantedId) {
  for (const child of children(bytes, start, end)) {
    if (child.id === wantedId) return child;
  }
  return null;
}

export function readUint(bytes, start, end) {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i];
  return value;
}

export function readFloat(bytes, start, end) {
  const len = end - start;
  const buf = new ArrayBuffer(len);
  new Uint8Array(buf).set(bytes.subarray(start, end));
  const view = new DataView(buf);
  if (len === 4) return view.getFloat32(0, false);
  if (len === 8) return view.getFloat64(0, false);
  throw new Error(`Unsupported float width ${len}`);
}

export function readString(bytes, start, end) {
  return new TextDecoder('utf-8').decode(bytes.subarray(start, end));
}
