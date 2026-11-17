export interface Element {
  id: number;
  headerStart: number;
  dataStart: number;
  end: number;
  declaredEnd: number;
  unknownSize: boolean;
}

export interface VInt {
  value: number;
  length: number;
  unknown: boolean;
}

export const EBML_ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  defaultDuration: 0x23e383,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  displayWidth: 0x54b0,
  displayHeight: 0x54ba,
  displayUnit: 0x54b2,
  projection: 0x7670,
  projectionPoseRoll: 0x7675,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
  referenceBlock: 0xfb,
  discardPadding: 0x75a2,
  cues: 0x1c53bb6b,
  chapters: 0x1043a770,
  attachments: 0x1941a469,
  tags: 0x1254c367,
} as const;

export function readVint(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  keepMarker = false,
): VInt {
  if (offset >= limit) throw new Error("EBML 数据在 VINT 前结束。");
  const first = bytes[offset];
  if (first === 0) throw new Error("非法 EBML VINT：首字节为 0。");

  let length = 1;
  let marker = 0x80;
  while (!(first & marker)) {
    marker >>= 1;
    length += 1;
  }
  if (offset + length > limit) throw new Error("EBML VINT 越过数据边界。");

  let value = keepMarker ? first : first & (marker - 1);
  let allOnes = (value & (marker - 1)) === marker - 1;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index];
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }

  return { value, length, unknown: allOnes && !keepMarker };
}

export function readElement(
  bytes: Uint8Array,
  offset: number,
  limit: number,
): Element {
  const rawId = readVint(bytes, offset, limit, true);
  const sizeOffset = offset + rawId.length;
  const rawSize = readVint(bytes, sizeOffset, limit);
  const dataStart = sizeOffset + rawSize.length;
  const declaredEnd = rawSize.unknown
    ? limit
    : Math.min(limit, dataStart + rawSize.value);

  return {
    id: rawId.value,
    headerStart: offset,
    dataStart,
    end: declaredEnd,
    declaredEnd,
    unknownSize: rawSize.unknown,
  };
}

export function* childElements(
  bytes: Uint8Array,
  start: number,
  end: number,
): Generator<Element> {
  let offset = start;
  while (offset < end) {
    const element = readElement(bytes, offset, end);
    yield element;
    if (element.end <= offset) break;
    offset = element.end;
  }
}

export function readUint(bytes: Uint8Array, element: Element): number {
  let value = 0;
  for (let index = element.dataStart; index < element.end; index += 1) {
    value = value * 256 + bytes[index];
  }
  return value;
}

export function readInt(bytes: Uint8Array, element: Element): number {
  const length = element.end - element.dataStart;
  if (length === 0) return 0;
  let value = readUint(bytes, element);
  const signBit = 2 ** (length * 8 - 1);
  if (value >= signBit) value -= 2 ** (length * 8);
  return value;
}

export function readFloat(bytes: Uint8Array, element: Element): number {
  const length = element.end - element.dataStart;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + element.dataStart,
    length,
  );
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return 0;
}

export function readString(bytes: Uint8Array, element: Element): string {
  return new TextDecoder().decode(bytes.subarray(element.dataStart, element.end));
}

export function readBytes(bytes: Uint8Array, element: Element): Uint8Array {
  return bytes.subarray(element.dataStart, element.end);
}

export function findElement(
  bytes: Uint8Array,
  start: number,
  end: number,
  id: number,
): Element | undefined {
  for (const element of childElements(bytes, start, end)) {
    if (element.id === id) return element;
  }
  return undefined;
}
