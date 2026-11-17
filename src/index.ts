import * as fs from "fs";
import { parseMp4, Mp4Metadata } from "./parser";

function fmt(n: number, digits = 3): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function printReport(meta: Mp4Metadata): void {
  console.log(`File size: ${meta.fileSize} bytes`);
  if (meta.ftyp) {
    console.log(
      `ftyp: major=${meta.ftyp.majorBrand} minor=${meta.ftyp.minorVersion} ` +
        `compatible=[${meta.ftyp.compatibleBrands.join(", ")}]`
    );
  }
  if (meta.movieTimescale !== null) {
    console.log(
      `Movie: timescale=${meta.movieTimescale} duration=${fmt(meta.movieDurationSeconds ?? 0)}s`
    );
  }
  for (const t of meta.tracks) {
    if (t.kind === "video") {
      console.log(`\nVideo track #${t.trackId}:`);
      console.log(`  codec      : ${t.codec}`);
      console.log(`  timescale  : ${t.timescale}`);
      console.log(`  duration   : ${t.durationUnits} units (${fmt(t.durationSeconds)}s)`);
      console.log(`  resolution : ${t.width}x${t.height}`);
      console.log(`  rotation   : ${t.rotationDegrees} deg`);
      console.log(`  matrix     : [${t.matrix.join(", ")}]`);
      console.log(
        `  keyframes  : ${
          t.keyframeSamples === null
            ? "not declared (all samples are keyframes)"
            : `[${t.keyframeSamples.join(", ")}]`
        }`
      );
    } else {
      console.log(`\nAudio track #${t.trackId}:`);
      console.log(`  codec      : ${t.codec}`);
      console.log(`  timescale  : ${t.timescale}`);
      console.log(`  duration   : ${t.durationUnits} units (${fmt(t.durationSeconds)}s)`);
      console.log(`  sample rate: ${t.sampleRate} Hz`);
      console.log(`  channels   : ${t.channels}`);
    }
  }
  if (meta.unknownBoxes.length > 0) {
    console.log(`\nSkipped boxes (${meta.unknownBoxes.length}):`);
    for (const b of meta.unknownBoxes) {
      console.log(`  @0x${b.offset.toString(16)} '${b.type}' size=${b.size}`);
    }
  }
  if (meta.issues.length > 0) {
    console.log(`\nIssues (${meta.issues.length}):`);
    for (const i of meta.issues) {
      console.log(`  @0x${i.offset.toString(16)} (${i.offset}): ${i.message}`);
    }
  } else {
    console.log(`\nNo issues.`);
  }
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: mp4info <file.mp4>");
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  const meta = parseMp4(buf);
  printReport(meta);
  if (meta.issues.length > 0) process.exit(1);
}

main();
