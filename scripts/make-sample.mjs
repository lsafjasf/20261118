// 生成测试样本：normal.mp4（含未知 box 与扩展尺寸 box）和 truncated.mp4（故意截断）。
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
fs.mkdirSync(outDir, { recursive: true });

function u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); return b; }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; }
function i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; }
function u24(v) { const b = Buffer.alloc(3); b.writeUIntBE(v, 0, 3); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; }
function cc(s) { return Buffer.from(s, "latin1"); }
function box(type, ...payloads) {
  const body = Buffer.concat(payloads);
  return Buffer.concat([u32(8 + body.length), cc(type), body]);
}
// 扩展尺寸 box（size32 == 1 + 64 位 largesize）
function bigBox(type, ...payloads) {
  const body = Buffer.concat(payloads);
  return Buffer.concat([u32(1), cc(type), u64(16 + body.length), body]);
}
function fullBox(type, version, flags, ...payloads) {
  return box(type, Buffer.concat([u8(version), u24(flags), ...payloads]));
}

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const ROT90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];

function mvhd(timescale, duration) {
  return fullBox("mvhd", 0, 0,
    u32(0), u32(0), u32(timescale), u32(duration),
    i32(0x10000), i16(0x100), i16(0),
    Buffer.alloc(8),
    ...IDENTITY.map(i32),
    Buffer.alloc(24),
    u32(3));
}

function tkhd(trackId, duration, matrix, width, height, volume) {
  return fullBox("tkhd", 0, 3,
    u32(0), u32(0), u32(trackId), u32(0), u32(duration),
    Buffer.alloc(8),
    i16(0), i16(0), i16(volume), i16(0),
    ...matrix.map(i32),
    u32(width << 16), u32(height << 16));
}

function mdhd(timescale, duration) {
  return fullBox("mdhd", 0, 0,
    u32(0), u32(0), u32(timescale), u32(duration),
    u16(0x55c4), u16(0));
}

function hdlr(handler, name) {
  return fullBox("hdlr", 0, 0,
    u32(0), cc(handler), Buffer.alloc(12), cc(name), u8(0));
}

function stsdVideo(width, height) {
  const avc1 = Buffer.concat([
    u32(8 + 78), cc("avc1"),
    Buffer.alloc(6), u16(1), Buffer.alloc(16),
    u16(width), u16(height),
    u32(0x480000), u32(0x480000), u32(0), u16(1),
    Buffer.alloc(32), u16(0x18), i16(-1),
  ]);
  return fullBox("stsd", 0, 0, u32(1), avc1);
}

function stsdAudio(channels, sampleRate) {
  const mp4a = Buffer.concat([
    u32(8 + 28), cc("mp4a"),
    Buffer.alloc(6), u16(1), Buffer.alloc(8),
    u16(channels), u16(16), u16(0), u16(0),
    u32(sampleRate << 16),
  ]);
  return fullBox("stsd", 0, 0, u32(1), mp4a);
}

const videoTrak = box("trak",
  tkhd(1, 5000, ROT90, 1920, 1080, 0),
  box("mdia",
    mdhd(90000, 450000),
    hdlr("vide", "VideoHandler"),
    box("minf",
      fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
      box("dinf", fullBox("dref", 0, 0, u32(0))),
      box("stbl",
        stsdVideo(1920, 1080),
        fullBox("stts", 0, 0, u32(0)),
        fullBox("stss", 0, 0, u32(3), u32(1), u32(61), u32(121)),
        fullBox("stsz", 0, 0, u32(0), u32(0)),
        fullBox("stco", 0, 0, u32(0))))));

const audioTrak = box("trak",
  tkhd(2, 5000, IDENTITY, 0, 0, 0x100),
  box("mdia",
    mdhd(48000, 240000),
    hdlr("soun", "SoundHandler"),
    box("minf",
      fullBox("smhd", 0, 0, i16(0), i16(0)),
      box("dinf", fullBox("dref", 0, 0, u32(0))),
      box("stbl",
        stsdAudio(2, 48000),
        fullBox("stts", 0, 0, u32(0)),
        fullBox("stsz", 0, 0, u32(0), u32(0)),
        fullBox("stco", 0, 0, u32(0))))));

const file = Buffer.concat([
  box("ftyp", cc("isom"), u32(512), cc("isom"), cc("iso2"), cc("avc1"), cc("mp41")),
  box("free", Buffer.alloc(16)),                 // 未知/填充 box：应被跳过并记录
  bigBox("junk", Buffer.alloc(24)),              // 扩展尺寸 box：应被跳过并记录
  box("moov", mvhd(1000, 5000), videoTrak, audioTrak),
  box("mdat", Buffer.alloc(64)),
]);

const normalPath = path.join(outDir, "normal.mp4");
fs.writeFileSync(normalPath, file);

// 故意截断：切在 moov 内部（音频 trak 的 stbl 附近）
const cutAt = file.length - 140;
const truncPath = path.join(outDir, "truncated.mp4");
fs.writeFileSync(truncPath, file.subarray(0, cutAt));

console.log(`wrote ${normalPath} (${file.length} bytes)`);
console.log(`wrote ${truncPath} (${cutAt} bytes, cut inside moov)`);
