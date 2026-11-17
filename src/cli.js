#!/usr/bin/env node
// Usage:
//   node src/cli.js --out final.webm --playlist playlist.json chunk1.webm chunk2.webm ...
// Files are stitched in filename order; pass --json to emit the playlist to
// stdout instead of writing files.
import { readFileSync, writeFileSync } from "node:fs";
import { stitchWebmChunks } from "./webm-stitcher.js";

function parseArgs(argv) {
  const args = { positional: [], out: null, playlist: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--playlist") args.playlist = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else args.positional.push(arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length === 0) {
    process.stdout.write(
      "Usage: node src/cli.js [--out final.webm] [--playlist playlist.json] [--json] <chunk ...>\n",
    );
    process.exit(args.help ? 0 : 1);
  }

  const entries = args.positional.map((filePath, index) => ({
    id: filePath,
    sequence: index,
    data: readFileSync(filePath),
  }));
  const result = await stitchWebmChunks(entries);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.playlist, null, 2)}\n`);
    return;
  }
  const outPath = args.out ?? "stitched.webm";
  const playlistPath = args.playlist ?? "playlist.json";
  writeFileSync(outPath, result.bytes);
  writeFileSync(playlistPath, `${JSON.stringify(result.playlist, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${outPath} (${result.bytes.length} bytes, ` +
      `${result.playlist.durationSeconds}s) and ${playlistPath}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
