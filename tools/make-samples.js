/* tools/make-samples.js — 生成结构合法的 WebM 测试分片
 * 不依赖 ffmpeg：直接按 EBML 规范手工封装。
 * 输出 samples/{normal,reversed,truncated,duplicated}/chunk-XX.webm */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'samples');

/* ---------- EBML 封装辅助 ---------- */

function idBytes(id) {
  const bytes = [];
  if (id > 0xFFFFFF) bytes.push((id >>> 24) & 0xFF);
  if (id > 0xFFFF) bytes.push((id >>> 16) & 0xFF);
  if (id > 0xFF) bytes.push((id >>> 8) & 0xFF);
  bytes.push(id & 0xFF);
  return Buffer.from(bytes);
}

function sizeVint(n) {
  let len = 1;
  while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
  const buf = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) {
    buf[i] = n & 0xFF;
    n = Math.floor(n / 256);
  }
  buf[0] |= 1 << (8 - len);
  return buf;
}

function el(id, data) {
  return Buffer.concat([idBytes(id), sizeVint(data.length), data]);
}

function uintEl(id, value, width) {
  let len = width || 1;
  while (len < 8 && value >= Math.pow(2, 8 * len)) len++;
  const buf = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) {
    buf[i] = value & 0xFF;
    value = Math.floor(value / 256);
  }
  return el(id, buf);
}

function strEl(id, s) {
  return el(id, Buffer.from(s, 'utf8'));
}

function floatEl(id, value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value, 0);
  return el(id, buf);
}

/* ---------- WebM 结构 ---------- */

const CLUSTER_TIMECODES = [0, 120, 240, 360, 480]; // ms（TimecodeScale=1000000ns）

function ebmlHeader() {
  return el(0x1A45DFA3, Buffer.concat([
    uintEl(0x4286, 1), // EBMLVersion
    uintEl(0x42F7, 1), // EBMLReadVersion
    uintEl(0x42F2, 4), // EBMLMaxIDLength
    uintEl(0x42F3, 8), // EBMLMaxSizeLength
    strEl(0x4282, 'webm'), // DocType
    uintEl(0x4287, 4), // DocTypeVersion
    uintEl(0x4285, 2), // DocTypeReadVersion
  ]));
}

function segmentHead() {
  // Segment 尺寸未知（0xFF…），与 MediaRecorder 实时输出一致
  const unknownSize = Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  const info = el(0x1549A966, Buffer.concat([
    uintEl(0x2AD7B1, 1000000), // TimecodeScale = 1ms
    strEl(0x4D80, 'webm-chunk-doctor'),
    strEl(0x5741, 'make-samples.js'),
    floatEl(0x4489, 500.0), // Duration
  ]));
  const video = el(0xE0, Buffer.concat([
    uintEl(0xB0, 640),
    uintEl(0xBA, 360),
  ]));
  const trackEntry = el(0xAE, Buffer.concat([
    uintEl(0xD7, 1), // TrackNumber
    uintEl(0x73C5, 1), // TrackUID
    uintEl(0x83, 1), // TrackType = video
    strEl(0x86, 'V_VP8'),
    video,
  ]));
  const tracks = el(0x1654AE6B, trackEntry);
  return Buffer.concat([idBytes(0x18538067), unknownSize, info, tracks]);
}

function cluster(timecode, index) {
  // 伪 VP8 负载：确定性伪随机字节，结构合法即可（验证只关心 EBML 结构）
  const payload = Buffer.alloc(200);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (index * 37 + i * 13 + 11) & 0xFF;
  }
  const blockHeader = Buffer.concat([
    Buffer.from([0x81]), // TrackNumber 1 (vint)
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(timecode, 0); return b; })(),
    Buffer.from([0x80]), // flags: keyframe
  ]);
  const simpleBlock = el(0xA3, Buffer.concat([blockHeader, payload]));
  return el(0x1F43B675, Buffer.concat([uintEl(0xE7, timecode), simpleBlock]));
}

/* ---------- 分片集生成 ---------- */

function buildChunks() {
  const chunks = [];
  chunks.push({
    name: 'chunk-00.webm',
    data: Buffer.concat([ebmlHeader(), segmentHead(), cluster(CLUSTER_TIMECODES[0], 0)]),
  });
  for (let i = 1; i < CLUSTER_TIMECODES.length; i++) {
    chunks.push({
      name: `chunk-0${i}.webm`,
      data: cluster(CLUSTER_TIMECODES[i], i),
    });
  }
  return chunks;
}

function writeSet(dir, chunks) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const chunk of chunks) {
    fs.writeFileSync(path.join(dir, chunk.name), chunk.data);
  }
}

function main() {
  const base = buildChunks();

  // 1) 正常顺序
  writeSet(path.join(OUT, 'normal'), base);

  // 2) 完全倒序（文件名按字典序读取即为倒序内容）
  const reversed = base.slice().reverse().map((chunk, i) => ({
    name: `chunk-0${i}.webm`,
    data: chunk.data,
  }));
  writeSet(path.join(OUT, 'reversed'), reversed);

  // 3) 末尾截断：最后一个分片砍掉 137 字节（截在 SimpleBlock 负载中间）
  const truncated = base.map((c) => ({ ...c }));
  const last = truncated[truncated.length - 1];
  last.data = last.data.slice(0, last.data.length - 137);
  writeSet(path.join(OUT, 'truncated'), truncated);

  // 4) 重复 Cluster：在时间码 480 之后再塞一份时间码 240 的 Cluster
  const duplicated = base.map((c) => ({ ...c }));
  duplicated.push({ name: 'chunk-05.webm', data: cluster(CLUSTER_TIMECODES[2], 2) });
  writeSet(path.join(OUT, 'duplicated'), duplicated);

  for (const setName of ['normal', 'reversed', 'truncated', 'duplicated']) {
    const dir = path.join(OUT, setName);
    const files = fs.readdirSync(dir).sort();
    const total = files.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    console.log(`${setName}: ${files.length} 个分片, 共 ${total} 字节`);
  }
}

main();
