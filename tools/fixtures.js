import { access, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(toolsDir, "..");
export const fixtureDir = path.join(rootDir, "test", ".fixtures");
const lockDir = path.join(rootDir, "test", ".fixtures.lock");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    const module = await import("ffmpeg-static");
    if (module.default && await exists(module.default)) return module.default;
  } catch {
    // Fall through to a system ffmpeg.
  }
  const lookup = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" });
  return lookup.status === 0 ? lookup.stdout.trim() : null;
}

async function ready() {
  if (!await exists(path.join(fixtureDir, "init.mp4"))) return false;
  const entries = await readdir(fixtureDir);
  return entries.filter((name) => /^seg-\d+\.m4s$/.test(name)).length >= 6;
}

async function waitForOtherGenerator() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await ready()) return true;
    await delay(250);
  }
  return false;
}

async function generate(ffmpeg) {
  await mkdir(fixtureDir, { recursive: true });
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "64k",
    "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(fixtureDir, "seg-%05d.m4s"),
    path.join(fixtureDir, "index.m3u8"),
  ];
  const result = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed: ${result.stderr || result.error}`);
  }
}

export async function ensureFixtures() {
  if (await ready()) return fixturePaths();
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is required to generate browser fixtures");

  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await waitForOtherGenerator()) return fixturePaths();
    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir);
  }

  try {
    if (!await ready()) await generate(ffmpeg);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
  return fixturePaths();
}

export function fixturePaths() {
  return {
    init: path.join(fixtureDir, "init.mp4"),
    segments: Array.from({ length: 6 }, (_, index) =>
      path.join(fixtureDir, `seg-${String(index).padStart(5, "0")}.m4s`)),
    playlist: path.join(fixtureDir, "index.m3u8"),
  };
}
