import { Buffer } from "node:buffer";

export function readUInt64BE(buffer, offset) {
  return buffer.readBigUInt64BE(offset);
}

export function writeUInt64BE(buffer, value, offset) {
  buffer.writeBigUInt64BE(BigInt(value), offset);
}

export function uint64ToNumber(value, label = "value") {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

export function asBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

export function fourCC(buffer, offset) {
  return buffer.toString("latin1", offset, offset + 4);
}

export function readBoxes(buffer, start = 0, end = buffer.length) {
  const boxes = [];
  let offset = start;

  while (offset < end) {
    if (end - offset < 8) {
      throw new Error(`Truncated box header at byte ${offset}`);
    }
    let size = buffer.readUInt32BE(offset);
    const type = fourCC(buffer, offset + 4);
    let headerSize = 8;

    if (size === 1) {
      if (end - offset < 16) {
        throw new Error(`Truncated extended box header at byte ${offset}`);
      }
      const extendedSize = readUInt64BE(buffer, offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`Box ${type} at byte ${offset} is too large`);
      }
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
      throw new Error(
        `Invalid ${type} box at byte ${offset}: size ${size}, available ${end - offset}`,
      );
    }

    boxes.push({
      type,
      start: offset,
      size,
      headerSize,
      dataStart: offset + headerSize,
      dataEnd: offset + size,
      end: offset + size,
    });
    offset += size;
  }

  return boxes;
}

export function findBox(boxes, type) {
  return boxes.find((box) => box.type === type) ?? null;
}

export function findBoxes(boxes, type) {
  return boxes.filter((box) => box.type === type);
}

export function childBoxes(buffer, parent) {
  return readBoxes(buffer, parent.dataStart, parent.dataEnd);
}

export function sliceBox(buffer, box) {
  return buffer.subarray(box.start, box.end);
}

export function readFullBox(buffer, box) {
  if (box.dataEnd - box.dataStart < 4) {
    throw new Error(`Truncated full box ${box.type}`);
  }
  return {
    version: buffer[box.dataStart],
    flags:
      (buffer[box.dataStart + 1] << 16) |
      (buffer[box.dataStart + 2] << 8) |
      buffer[box.dataStart + 3],
  };
}

export function boxString(buffer, box) {
  return buffer.toString("latin1", box.dataStart, box.dataEnd);
}
