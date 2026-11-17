// Encodes synthetic audio/video with WebCodecs and uploads the encoded
// chunks to the server, which later replays them over WebTransport.

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 30;
const SECONDS = 12;
const AUDIO_RATE = 48000;
const AUDIO_CHUNK_MS = 20;

const logEl = document.getElementById('log');
const log = (m) => {
  logEl.textContent += `\n${m}`;
  console.log(m);
};

function b64(bytes) {
  let bin = '';
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function drawFrame(ctx, index) {
  const t = index / FPS;
  ctx.fillStyle = '#102030';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const x = (Math.sin(t * 1.7) * 0.5 + 0.5) * (WIDTH - 60);
  const y = (Math.cos(t * 1.1) * 0.5 + 0.5) * (HEIGHT - 60);
  ctx.fillStyle = `hsl(${(t * 90) % 360} 80% 55%)`;
  ctx.fillRect(x, y, 60, 60);
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px monospace';
  ctx.fillText(`f=${index} t=${t.toFixed(2)}s`, 10, 24);
}

async function encodeVideo() {
  const chunks = [];
  let decoderConfig = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !decoderConfig) {
        decoderConfig = { ...meta.decoderConfig };
        if (decoderConfig.description) decoderConfig.description = b64(decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        ts: chunk.timestamp / 1000,
        dur: (chunk.duration ?? 1e6 / FPS) / 1000,
        type: chunk.type,
        data: b64(data),
      });
    },
    error: (e) => log(`video encoder error: ${e.message}`),
  });
  const config = {
    codec: 'vp8',
    width: WIDTH,
    height: HEIGHT,
    framerate: FPS,
    bitrate: 600_000,
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('vp8 encode unsupported');
  encoder.configure(config);

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const total = FPS * SECONDS;
  for (let i = 0; i < total; i++) {
    drawFrame(ctx, i);
    const frame = new VideoFrame(canvas, {
      timestamp: (i * 1e6) / FPS,
      duration: 1e6 / FPS,
    });
    encoder.encode(frame, { keyFrame: i % FPS === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 10) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  await encoder.flush();
  encoder.close();
  log(`video: ${chunks.length} chunks`);
  return { config: decoderConfig ?? { codec: 'vp8' }, chunks };
}

async function encodeAudio() {
  const chunks = [];
  let decoderConfig = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !decoderConfig) {
        decoderConfig = { ...meta.decoderConfig };
        if (decoderConfig.description) decoderConfig.description = b64(decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        ts: chunk.timestamp / 1000,
        dur: (chunk.duration ?? AUDIO_CHUNK_MS * 1000) / 1000,
        type: chunk.type,
        data: b64(data),
      });
    },
    error: (e) => log(`audio encoder error: ${e.message}`),
  });
  const config = { codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: 1, bitrate: 64_000 };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('opus encode unsupported');
  encoder.configure(config);

  const framesPerChunk = (AUDIO_RATE * AUDIO_CHUNK_MS) / 1000;
  const totalChunks = (SECONDS * 1000) / AUDIO_CHUNK_MS;
  const pcm = new Float32Array(framesPerChunk);
  for (let c = 0; c < totalChunks; c++) {
    const t0 = (c * framesPerChunk) / AUDIO_RATE;
    for (let i = 0; i < framesPerChunk; i++) {
      const t = t0 + i / AUDIO_RATE;
      pcm[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t) + 0.1 * Math.sin(2 * Math.PI * 880 * t);
    }
    const data = new AudioData({
      format: 'f32',
      sampleRate: AUDIO_RATE,
      numberOfFrames: framesPerChunk,
      numberOfChannels: 1,
      timestamp: (c * framesPerChunk * 1e6) / AUDIO_RATE,
      data: pcm,
    });
    encoder.encode(data);
    data.close();
    if (encoder.encodeQueueSize > 10) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  await encoder.flush();
  encoder.close();
  log(`audio: ${chunks.length} chunks`);
  return { config: decoderConfig ?? { codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: 1 }, chunks };
}

async function main() {
  const video = await encodeVideo();
  const audio = await encodeAudio();
  const res = await fetch('/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ video, audio }),
  });
  log(`upload: ${res.status} ${await res.text()}`);
  window.__done = res.ok;
}

main().catch((e) => {
  log(`FAILED: ${e.message}`);
  window.__done = false;
});
