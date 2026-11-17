/** 解析错误：始终携带出错的字节偏移。 */
export class Mp4ParseError extends Error {
  readonly offset: number;
  constructor(offset: number, message: string) {
    super(`@0x${offset.toString(16)} (${offset}): ${message}`);
    this.name = "Mp4ParseError";
    this.offset = offset;
  }
}

/**
 * 基于 Buffer 的只读游标。
 * 所有读取都先做边界检查，越界即抛 Mp4ParseError（含偏移），绝不读到缓冲区外。
 */
export class Reader {
  readonly buf: Buffer;
  readonly start: number; // 窗口在文件中的起始偏移
  readonly end: number; // 窗口结束偏移（不含）
  pos: number;

  constructor(buf: Buffer, start = 0, end = buf.length) {
    this.buf = buf;
    this.start = start;
    this.end = end;
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new Mp4ParseError(
        this.pos,
        `unexpected end of data while reading ${what} (need ${n} byte(s), ${this.remaining} left in window)`
      );
    }
  }

  u8(what = "uint8"): number {
    this.need(1, what);
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(what = "uint16"): number {
    this.need(2, what);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  i16(what = "int16"): number {
    this.need(2, what);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  u24(what = "uint24"): number {
    this.need(3, what);
    const v = this.buf.readUIntBE(this.pos, 3);
    this.pos += 3;
    return v;
  }

  u32(what = "uint32"): number {
    this.need(4, what);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(what = "int32"): number {
    this.need(4, what);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  /** 64 位无符号整数；超过 Number.MAX_SAFE_INTEGER 时抛错（时间尺度/时长场景下不现实）。 */
  u64(what = "uint64"): number {
    this.need(8, what);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Mp4ParseError(this.pos - 8, `${what} exceeds safe integer range`);
    }
    return Number(v);
  }

  fourCC(what = "fourcc"): string {
    this.need(4, what);
    const v = this.buf.toString("latin1", this.pos, this.pos + 4);
    this.pos += 4;
    return v;
  }

  /** 16.16 定点数 */
  fixed16_16(what = "fixed16.16"): number {
    return this.i32(what) / 65536;
  }

  /** 8.8 定点数 */
  fixed8_8(what = "fixed8.8"): number {
    return this.i16(what) / 256;
  }

  skip(n: number, what = "bytes"): void {
    this.need(n, what);
    this.pos += n;
  }

  bytes(n: number, what = "bytes"): Buffer {
    this.need(n, what);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}
