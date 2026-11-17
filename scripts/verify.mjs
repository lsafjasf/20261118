// 断言式验证：正常样本的元数据字段 + 截断样本的出错偏移。
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseMp4 } from "../dist/parser.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

const normal = parseMp4(fs.readFileSync(path.join(dir, "normal.mp4")));
check("normal: no issues", normal.issues.length === 0);
check("normal: ftyp major isom", normal.ftyp?.majorBrand === "isom");
check("normal: movie timescale 1000", normal.movieTimescale === 1000);
check("normal: movie duration 5s", normal.movieDurationSeconds === 5);
check("normal: 2 tracks", normal.tracks.length === 2);

const v = normal.tracks.find((t) => t.kind === "video");
check("video: codec avc1", v?.codec === "avc1");
check("video: timescale 90000", v?.timescale === 90000);
check("video: duration 5s", v?.durationSeconds === 5);
check("video: 1920x1080", v?.width === 1920 && v?.height === 1080);
check("video: rotation 90", v?.rotationDegrees === 90);
check("video: keyframes [1,61,121]",
  JSON.stringify(v?.keyframeSamples) === "[1,61,121]");

const a = normal.tracks.find((t) => t.kind === "audio");
check("audio: codec mp4a", a?.codec === "mp4a");
check("audio: 48000 Hz", a?.sampleRate === 48000);
check("audio: 2 channels", a?.channels === 2);

check("normal: extended-size 'junk' box skipped",
  normal.unknownBoxes.some((b) => b.type === "junk" && b.offset === 0x38));
check("normal: unknown 'free' box skipped",
  normal.unknownBoxes.some((b) => b.type === "free" && b.offset === 0x20));

const trunc = parseMp4(fs.readFileSync(path.join(dir, "truncated.mp4")));
check("truncated: issues reported", trunc.issues.length > 0);
check("truncated: error offset 0x60 (moov overrun)",
  trunc.issues[0]?.offset === 0x60);
check("truncated: deepest error at stsd @0x370",
  trunc.issues.some((i) => i.offset === 0x370 && i.message.includes("stsd")));
check("truncated: video track salvaged",
  trunc.tracks.some((t) => t.kind === "video" && t.codec === "avc1"));

const corrupt = parseMp4(fs.readFileSync(path.join(dir, "corrupt-size.mp4")));
check("corrupt size: reported at 0x60",
  corrupt.issues.some((i) => i.offset === 0x60 && i.message.includes("corrupt size")));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
