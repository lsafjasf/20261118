/* Verify the analyzer against the synthetic fixture with known anomalies. */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const OpusInspector = require("../js/opus-parser.js");

const fixture = path.join(__dirname, "fixtures", "sample-anomalies.opus");
fs.mkdirSync(path.dirname(fixture), { recursive: true });
execFileSync("python3", [path.join(__dirname, "..", "tools", "make_sample.py"), fixture]);

const buf = fs.readFileSync(fixture);
const result = OpusInspector.analyze(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}`);
  }
}

check("header input rate is 16000", result.header.inputRate === 16000);
check("header pre-skip is 312", result.header.preSkip === 312);
check("100 audio packets parsed", result.audioPacketCount === 100);

const byType = (type) => result.anomalies.filter((a) => a.type === type);
const atPacket = (type, idx) => byType(type).filter((a) => a.packetIndex === idx);

check("rollback localized to packet 22", atPacket("timestamp_rollback", 22).length === 1);
check("duplicate localized to packet 42", atPacket("duplicate_packet", 42).length >= 1);
check(
  "duplicate reports both timestamp and payload",
  atPacket("duplicate_packet", 42).length === 2
);

const gaps = byType("gap");
check("one loss gap found", gaps.length === 1);
check("gap at packet 62 (960 samples)", atPacket("gap", 62)[0] && atPacket("gap", 62)[0].gapSamples === 960);

const mismatches = byType("rate_mismatch");
check("rate mismatch at packets 72-74",
  mismatches.length === 3 &&
    mismatches.every((a, i) => a.packetIndex === 72 + i));

check("no pre-skip anomaly on consistent file", byType("preskip_inconsistent").length === 0);
check("no false rollbacks", byType("timestamp_rollback").length === 1);

const durations = result.packets.map((p) => p.durationMs);
check("normal packets are 10 ms", durations[0] === 10 && durations[50] === 10);
check("full-band packets are 20 ms", durations[70] === 20 && durations[72] === 20);

check("anomalies carry time positions", result.anomalies.every((a) => typeof a.timeMs === "number"));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
