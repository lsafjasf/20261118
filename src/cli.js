import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MergeError, mergeInputs, readInputs, verifyMerged } from "./merge.js";

function usage() {
  return `Usage: fmp4-merge [options] <init.mp4> <segment...>

Merge one ftyp/moov init segment and one or more moof/mdat media segments
into a single fragmented MP4 with a continuous decode timeline.

Options:
  -o, --output <file>       Output MP4 (default: merged.mp4)
  --sequence-from <mode>    auto | filename | mfhd | order (default: auto)
  --allow-gaps              Merge available fragments and report missing indices
  --json                    Print a machine-readable report
  -h, --help                Show this help
`;
}

function parseArgs(argv) {
  const options = {
    output: "merged.mp4",
    sequenceFrom: undefined,
    allowGaps: false,
    json: false,
  };
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "-o" || arg === "--output") {
      options.output = argv[++index];
      if (!options.output) throw new Error(`${arg} requires a path`);
    } else if (arg === "--sequence-from") {
      options.sequenceFrom = argv[++index];
      if (!["auto", "filename", "mfhd", "order"].includes(options.sequenceFrom)) {
        throw new Error("--sequence-from must be auto, filename, mfhd, or order");
      }
    } else if (arg === "--allow-gaps") {
      options.allowGaps = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { options, files };
}

function formatSeconds(value) {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

function formatKeyframes(times) {
  if (!times || times.length === 0) return "-";
  return times.map((time) => formatSeconds(time)).join(", ");
}

function integrityProblems(inputs) {
  const problems = [];
  if (inputs.duplicates.duplicateIndices.length > 0) {
    for (const duplicate of inputs.duplicates.duplicateIndices) {
      problems.push(
        `duplicate source sequence #${duplicate.sourceIndex}: ${duplicate.files.join(", ")}`,
      );
    }
  }
  for (const duplicate of inputs.duplicates.duplicateContent) {
    problems.push(
      `identical media content: ${duplicate.files.join(", ")} ` +
        `(source #${duplicate.sourceIndices.join(", #")})`,
    );
  }
  return problems;
}

function printTextReport(inputs, result, verification, outputPath) {
  console.log("Input integrity");
  console.log(`  sequence source : ${inputs.sequenceSource}`);
  console.log(`  media segments  : ${inputs.media.length}`);
  console.log(
    `  missing sources : ${inputs.missing.length ? inputs.missing.join(", ") : "none"}`,
  );
  const problems = integrityProblems(inputs);
  console.log(`  duplicates      : ${problems.length ? problems.join("; ") : "none"}`);
  console.log("");
  console.log("Segment report");
  console.log("  #    source                              samples  keyframe starts (s)          duration (s)");
  for (const segment of result.segments) {
    const source = `${path.basename(segment.sourceName)} (source #${segment.sourceIndex})`;
    console.log(
      `  ${String(segment.sourceIndex).padEnd(4)} ${source.padEnd(35)} ` +
        `${String(segment.sampleCount).padStart(7)}  ` +
        `${formatKeyframes(segment.keyframeTimes).padEnd(27)} ` +
        `${formatSeconds(segment.durationSeconds).padStart(12)}`,
    );
  }
  console.log("");
  console.log("Track totals");
  for (const track of result.tracks) {
    console.log(
      `  track ${track.trackId} (${track.handler}): ` +
        `${formatSeconds(track.durationSeconds)} s`,
    );
  }
  console.log(`Estimated merged duration: ${formatSeconds(result.durationSeconds)} s`);
  console.log(
    `Timeline verification: ${verification.fragmentCount} fragments, continuous tfdt`,
  );
  console.log(`Wrote ${outputPath} (${result.buffer.length} bytes)`);
}

export async function run(argv) {
  const { options, files } = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (files.length < 2) {
    console.error(usage());
    return 64;
  }

  const inputs = await readInputs(files, { sequenceFrom: options.sequenceFrom });
  const problems = integrityProblems(inputs);
  if (problems.length > 0) {
    console.error("Duplicate segments were blocked:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 2;
  }
  if (inputs.missing.length > 0 && !options.allowGaps) {
    console.error(`Missing source sequence numbers: ${inputs.missing.join(", ")}`);
    console.error("No output was written. Use --allow-gaps only when a compressed gap is intended.");
    return 3;
  }

  const result = mergeInputs(inputs, { allowGaps: options.allowGaps });
  const verification = verifyMerged(result.buffer);
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.buffer);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          output: outputPath,
          bytes: result.buffer.length,
          sequenceSource: inputs.sequenceSource,
          missing: inputs.missing,
          duplicates: problems,
          durationSeconds: result.durationSeconds,
          tracks: result.tracks,
          verification,
          segments: result.segments.map((segment) => ({
            sourceName: segment.sourceName,
            sourceIndex: segment.sourceIndex,
            sampleCount: segment.sampleCount,
            keyframeStarts: segment.keyframeTimes,
            durationSeconds: segment.durationSeconds,
            tracks: segment.tracks,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    printTextReport(inputs, result, verification, outputPath);
  }
  return 0;
}

export function reportError(error) {
  if (error instanceof MergeError) {
    console.error(error.message);
    if (error.details?.duplicateIndices) {
      for (const duplicate of error.details.duplicateIndices) {
        console.error(
          `  - source #${duplicate.sourceIndex}: ${duplicate.files.join(", ")}`,
        );
      }
    }
    if (error.details?.missing) {
      console.error(`  - missing source sequence numbers: ${error.details.missing.join(", ")}`);
    }
    return true;
  }
  return false;
}
