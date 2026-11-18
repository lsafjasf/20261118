import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const root = resolve(process.cwd());
const outputDir = join(root, "media", "stream");
const adWindows = "between(t\\,0\\,6)+between(t\\,12\\,24)+between(t\\,30\\,42)";
const filter = [
  `drawbox=x=0:y=0:w=640:h=360:color=0x6d3d18:t=fill:enable='${adWindows}'`,
  "drawgrid=w=40:h=40:t=1:c=0xffffff@0.07",
  "drawbox=x=24:y=24:w=592:h=312:color=0xd7e8ff@0.08:t=1",
  "drawbox=x=42:y=124:w=280:h=4:color=0x9ed8ff@0.9:t=fill",
  "drawbox=x=42:y=146:w=160:h=4:color=0x9ed8ff@0.35:t=fill",
  "drawbox=x=0:y='mod(t*42,360)':w=640:h=2:color=0xa7e7ff@0.45:t=fill",
  "drawbox=x=42:y=270:w=556:h=30:color=0x0b1725@0.55:t=fill",
  "drawbox=x=42:y=312:w='mod(t*11.58,556)':h=3:color=0x9ed8ff@0.9:t=fill"
].join(",");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolveRun() : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await run(ffmpegPath, [
  "-hide_banner", "-y",
  "-f", "lavfi", "-i", "color=c=0x0b1725:s=640x360:r=30:d=48",
  "-f", "lavfi", "-i", "sine=frequency=196:sample_rate=48000:duration=48",
  "-vf", filter,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
  "-pix_fmt", "yuv420p", "-g", "90", "-keyint_min", "90", "-sc_threshold", "0",
  "-force_key_frames", "expr:gte(t,n_forced*3)",
  "-c:a", "aac", "-b:a", "64k", "-ac", "1",
  "-f", "hls", "-hls_time", "3", "-hls_list_size", "0",
  "-hls_segment_filename", join(outputDir, "segment-%03d.ts"),
  join(outputDir, "_generated.m3u8")
]);

const scte = {
  pre: "0xFC302000000000000000",
  mid: "0xFC302100000000000001",
  skew: "0xFC302300000000000002"
};

const lines = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:3",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  `#EXT-X-CUE-OUT:DURATION=6.000,SCTE35-OUT=${scte.pre}`,
  `#EXT-OATCLS-SCTE35:${scte.pre}`,
  "#EXTINF:3.000,",
  "segment-000.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=3.000,DURATION=6.000,SCTE35=${scte.pre}`,
  "#EXTINF:3.000,",
  "segment-001.ts",
  `#EXT-X-CUE-IN:SCTE35-IN=${scte.pre}`,
  "#EXTINF:3.000,",
  "segment-002.ts",
  "#EXTINF:3.000,",
  "segment-003.ts",
  `#EXT-X-CUE-OUT:DURATION=12.000,SCTE35-OUT=${scte.mid}`,
  `#EXT-OATCLS-SCTE35:${scte.mid}`,
  "#EXTINF:3.000,",
  "segment-004.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=3.000,DURATION=12.000,SCTE35=${scte.mid}`,
  "#EXTINF:3.000,",
  "segment-005.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=6.000,DURATION=12.000,SCTE35=${scte.mid}`,
  "#EXTINF:3.000,",
  "segment-006.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=9.000,DURATION=12.000,SCTE35=${scte.mid}`,
  "#EXTINF:3.000,",
  "segment-007.ts",
  `#EXT-X-CUE-IN:SCTE35-IN=${scte.mid}`,
  "#EXTINF:3.000,",
  "segment-008.ts",
  "#EXTINF:3.000,",
  "segment-009.ts",
  `#EXT-X-CUE-OUT:DURATION=14.000,SCTE35-OUT=${scte.skew}`,
  `#EXT-OATCLS-SCTE35:${scte.skew}`,
  "#EXTINF:3.000,",
  "segment-010.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=3.000,DURATION=14.000,SCTE35=${scte.skew}`,
  "#EXTINF:3.000,",
  "segment-011.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=6.000,DURATION=14.000,SCTE35=${scte.skew}`,
  "#EXTINF:3.000,",
  "segment-012.ts",
  `#EXT-X-CUE-OUT-CONT:ELAPSEDTIME=9.000,DURATION=14.000,SCTE35=${scte.skew}`,
  "#EXTINF:3.000,",
  "segment-013.ts",
  `#EXT-X-CUE-IN:SCTE35-IN=${scte.skew}`,
  "#EXTINF:3.000,",
  "segment-014.ts",
  "#EXTINF:3.000,",
  "segment-015.ts",
  "#EXT-X-ENDLIST",
  ""
];

await writeFile(join(outputDir, "demo.m3u8"), lines.join("\n"));
await rm(join(outputDir, "_generated.m3u8"), { force: true });
console.log(`Generated 16 HLS fragments in ${outputDir}`);
