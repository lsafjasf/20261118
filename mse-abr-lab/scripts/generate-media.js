const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'media-work');
const OUT = path.join(ROOT, 'public', 'media');

const DURATION = 60;
const SEGMENT_SECONDS = 2;

const RENDITIONS = [
  { id: 'r0', label: '300k', bitrate: 300_000, target: '300k', maxrate: '330k', bufsize: '600k' },
  { id: 'r1', label: '800k', bitrate: 800_000, target: '800k', maxrate: '880k', bufsize: '1600k' },
  { id: 'r2', label: '1500k', bitrate: 1_500_000, target: '1500k', maxrate: '1650k', bufsize: '3000k' },
];

function run(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function probe(file) {
  return JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ]).toString());
}

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

module.exports = { ROOT, WORK, OUT, DURATION, SEGMENT_SECONDS, RENDITIONS, run, probe };

const mezzanine = path.join(WORK, 'mezzanine.mp4');

if (!fs.existsSync(mezzanine)) {
  console.log('[1/3] Synthesizing mezzanine (60s, moving test pattern + 440Hz tone)...');
  const seconds = String(DURATION);
  const boxes = [];
  for (let bit = 0; bit < 6; bit += 1) {
    const x = 24 + bit * 34;
    boxes.push(`drawbox=x=${x}:y=24:w=28:h=28:color=white@0.85:t=fill:enable='lt(mod(floor(t/${1}),pow(2,${bit + 1})),pow(2,${bit}))'`);
  }
  for (let bit = 0; bit < 5; bit += 1) {
    const x = 24 + bit * 26;
    boxes.push(`drawbox=x=${x}:y=64:w=20:h=16:color=yellow@0.9:t=fill:enable='lt(mod(floor(n),pow(2,${bit + 1})),pow(2,${bit}))'`);
  }
  const vf = [
    'drawbox=x=0:y=0:w=640:h=96:color=black@0.55:t=fill',
    ...boxes,
    'drawbox=x=mod(t*160\\,640):y=200:w=96:h=60:color=cyan@0.8:t=fill',
  ].join(',');
  run([
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60',
    '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    mezzanine,
  ]);
} else {
  console.log('[1/3] Mezzanine already exists, skipping synthesis.');
}

const manifest = {
  segmentSeconds: SEGMENT_SECONDS,
  durationSeconds: DURATION,
  videoMimeType: 'video/mp4; codecs="avc1.64001e,mp4a.40.2"',
  renditions: [],
};

console.log('[2/3] Encoding 3 renditions and splitting into 2s fMP4 segments...');
for (const rendition of RENDITIONS) {
  const dir = path.join(OUT, rendition.id);
  fs.mkdirSync(dir, { recursive: true });
  const playlist = path.join(dir, 'prog.m3u8');
  run([
    '-i', mezzanine,
    '-c:v', 'libx264', '-preset', 'medium',
    '-b:v', rendition.target, '-maxrate', rendition.maxrate,
    '-bufsize', rendition.bufsize,
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '3.0',
    '-g', String(30 * SEGMENT_SECONDS), '-keyint_min', String(30 * SEGMENT_SECONDS),
    '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '2',
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof+skip_sidx+disable_chpl',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.m4s'),
    playlist,
  ]);
  const segments = fs.readdirSync(dir)
    .filter((name) => /^seg_\d+\.m4s$/.test(name))
    .sort();
  const sizes = segments.map((name) => fs.statSync(path.join(dir, name)).size);
  manifest.renditions.push({
    id: rendition.id,
    label: rendition.label,
    bitrate: rendition.bitrate,
    init: `/media/${rendition.id}/init.mp4`,
    segments: segments.map((name, index) => ({
      index,
      url: `/media/${rendition.id}/${name}`,
      bytes: sizes[index],
    })),
  });
  console.log(`  ${rendition.id} (${rendition.label}): ${segments.length} segments`);
}

console.log('[3/3] Writing manifest.json');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Done. Output at', OUT);
