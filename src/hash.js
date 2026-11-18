// xxHash32 (streaming) and per-plane block hashing for raw YUV frames.
// Generic plane descriptors make this usable with WebCodecs VideoFrame
// (via planesToDescriptors) and raw I420 buffers from ffmpeg.

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function mul32(a, b) {
  return (Math.imul(a, b)) >>> 0;
}

function round(acc, input) {
  acc = (acc + mul32(input, PRIME32_2)) >>> 0;
  acc = rotl32(acc, 13);
  acc = mul32(acc, PRIME32_1);
  return acc >>> 0;
}

function avalanche(value) {
  value ^= value >>> 15;
  value = mul32(value, PRIME32_2);
  value ^= value >>> 13;
  value = mul32(value, PRIME32_3);
  value ^= value >>> 16;
  return value >>> 0;
}

export class XxHash32 {
  constructor(seed = 0) {
    this.seed = seed >>> 0;
    this.v1 = (this.seed + PRIME32_1 + PRIME32_2) >>> 0;
    this.v2 = (this.seed + PRIME32_2) >>> 0;
    this.v3 = this.seed >>> 0;
    this.v4 = (this.seed - PRIME32_1) >>> 0;
    this.total = 0;
    this.memory = new Uint8Array(16);
    this.memSize = 0;
    this.done = false;
  }

  update(input) {
    let data = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.total += data.length;
    let index = 0;

    if (this.memSize > 0) {
      while (index < data.length && this.memSize < 16) {
        this.memory[this.memSize] = data[index];
        this.memSize += 1;
        index += 1;
      }
      if (this.memSize === 16) {
        this.consumeStripe(this.memory, 0);
        this.memSize = 0;
      }
    }

    const blockEnd = index + ((data.length - index) & ~15);
    while (index < blockEnd) {
      this.consumeStripe(data, index);
      index += 16;
    }

    while (index < data.length) {
      this.memory[this.memSize] = data[index];
      this.memSize += 1;
      index += 1;
    }
    return this;
  }

  consumeStripe(data, offset) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 16);
    this.v1 = round(this.v1, view.getUint32(0, true));
    this.v2 = round(this.v2, view.getUint32(4, true));
    this.v3 = round(this.v3, view.getUint32(8, true));
    this.v4 = round(this.v4, view.getUint32(12, true));
  }

  digest() {
    if (this.done) return this.value;
    let hash;
    if (this.total >= 16) {
      hash = (rotl32(this.v1, 1) + rotl32(this.v2, 7) +
        rotl32(this.v3, 12) + rotl32(this.v4, 18)) >>> 0;
    } else {
      hash = (PRIME32_5 + this.seed) >>> 0;
    }
    hash = (hash + this.total) >>> 0;

    let index = 0;
    while (index + 4 <= this.memSize) {
      const lane = new DataView(this.memory.buffer, this.memory.byteOffset + index, 4)
        .getUint32(0, true);
      hash = (hash + mul32(lane, PRIME32_3)) >>> 0;
      hash = mul32(rotl32(hash, 17), PRIME32_4);
      index += 4;
    }
    while (index < this.memSize) {
      hash = (hash + mul32(this.memory[index], PRIME32_5)) >>> 0;
      hash = mul32(rotl32(hash, 11), PRIME32_1);
      index += 1;
    }

    this.value = avalanche(hash);
    this.done = true;
    return this.value;
  }
}

export function xxHash32(data, seed = 0) {
  return new XxHash32(seed).update(data).digest();
}

export function hashToHex(value) {
  return value.toString(16).padStart(8, '0');
}

// A plane descriptor: { width, height, stride, data: Uint8Array, offset }
// where data starts at the plane origin.
export function blocksForPlane(width, height, blockSize) {
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  return { cols, rows, count: cols * rows };
}

export function hashPlaneBlocks(plane, blockSize) {
  const { cols, rows } = blocksForPlane(plane.width, plane.height, blockSize);
  const hashes = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    hashes[row] = new Array(cols);
    const y0 = row * blockSize;
    const blockHeight = Math.min(blockSize, plane.height - y0);
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * blockSize;
      const blockWidth = Math.min(blockSize, plane.width - x0);
      const hasher = new XxHash32();
      for (let y = 0; y < blockHeight; y += 1) {
        const line = plane.data.subarray(
          (plane.offset || 0) + (y0 + y) * plane.stride + x0,
          (plane.offset || 0) + (y0 + y) * plane.stride + x0 + blockWidth,
        );
        hasher.update(line);
      }
      hashes[row][col] = hashToHex(hasher.digest());
    }
  }
  return { width: plane.width, height: plane.height, blockSize, cols, rows, hashes };
}

// Frame descriptor: { width, height, planes: [Y, U, V] } in I420 layout.
export function hashFrameBlocks(frame, blockSize) {
  const [luma, cb, cr] = frame.planes;
  return {
    width: frame.width,
    height: frame.height,
    blockSize,
    Y: hashPlaneBlocks(luma, blockSize),
    U: hashPlaneBlocks(cb, blockSize),
    V: hashPlaneBlocks(cr, blockSize),
  };
}

export function diffBlockGrids(reference, candidate) {
  const changed = [];
  for (const planeName of ['Y', 'U', 'V']) {
    const a = reference[planeName];
    const b = candidate[planeName];
    for (let row = 0; row < a.rows; row += 1) {
      for (let col = 0; col < a.cols; col += 1) {
        if (a.hashes[row][col] !== b.hashes[row][col]) {
          changed.push({
            plane: planeName,
            row,
            col,
            blockSize: a.blockSize,
            // Luma-equivalent pixel rectangle for overlay/selection.
            x: col * a.blockSize * (planeName === 'Y' ? 1 : 2),
            y: row * a.blockSize * (planeName === 'Y' ? 1 : 2),
            w: Math.min(a.blockSize * (planeName === 'Y' ? 1 : 2), reference.width - col * a.blockSize * (planeName === 'Y' ? 1 : 2)),
            h: Math.min(a.blockSize * (planeName === 'Y' ? 1 : 2), reference.height - row * a.blockSize * (planeName === 'Y' ? 1 : 2)),
            referenceHash: a.hashes[row][col],
            candidateHash: b.hashes[row][col],
          });
        }
      }
    }
  }
  return changed;
}

// Convert a WebCodecs VideoFrame (any pixel format) into I420 descriptors.
export async function videoFrameToI420Descriptors(videoFrame) {
  let frame = videoFrame;
  let converted = null;
  if (frame.format !== 'I420') {
    converted = new VideoFrame(frame, { format: 'I420' });
    frame = converted;
  }
  const width = frame.displayWidth || frame.width;
  const height = frame.displayHeight || frame.height;
  const codedWidth = frame.codedWidth || width;
  const codedHeight = frame.codedHeight || height;
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const fallbackLayout = [
    { offset: 0, stride: codedWidth },
    { offset: codedWidth * codedHeight, stride: Math.ceil(codedWidth / 2) },
    {
      offset: codedWidth * codedHeight + Math.ceil(codedWidth / 2) * Math.ceil(codedHeight / 2),
      stride: Math.ceil(codedWidth / 2),
    },
  ];
  let nativeLayout = null;
  try {
    if (typeof frame.layout === 'function') nativeLayout = frame.layout();
    if (nativeLayout && nativeLayout.length !== 3) nativeLayout = null;
  } catch {
    nativeLayout = null;
  }
  const data = new Uint8Array(frame.allocationSize());
  // copyTo returns the actual plane layout it wrote. Prefer an explicit
  // native layout() when available, otherwise capture the returned one,
  // falling back to packed I420 math.
  let layout = nativeLayout
    ? nativeLayout.map((entry) => ({ offset: entry.offset, stride: entry.stride }))
    : null;
  if (layout) {
    await frame.copyTo(data, { layout });
  } else {
    const returnedLayout = await frame.copyTo(data);
    layout = (returnedLayout && returnedLayout.length === 3)
      ? returnedLayout.map((entry) => ({ offset: entry.offset, stride: entry.stride }))
      : fallbackLayout;
  }
  if (converted) converted.close();

  const entries = layout;
  const dims = [
    { width, height },
    { width: cw, height: ch },
    { width: cw, height: ch },
  ];
  const planes = entries.map((entry, i) => ({
    width: dims[i].width,
    height: dims[i].height,
    stride: entry.stride,
    offset: entry.offset,
    data,
  }));
  return { width, height, planes };
}
