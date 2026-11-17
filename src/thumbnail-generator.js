// Chapter thumbnail wall generator built on the WebCodecs API.
//
// Memory contract:
//  - only `concurrency` EncodedVideoChunks are queued/decode in flight
//  - each decoded VideoFrame is registered, rasterized to a bitmap, and
//    closed immediately, so at most `concurrency` VideoFrames exist at once
//  - on abort the decoder is reset and every registered frame is closed,
//    leaving zero live VideoFrames even when outputs were queued

import { parseWebm } from './webm-parser.js';
import { resolveChapterFrames } from './chapter-targets.js';
import { runPool, AbortError } from './concurrency.js';
import { FrameRegistry } from './frame-registry.js';

const VP9_CODEC = 'vp09.00.10.08';

function pickVideoTrack(parsed) {
  const track = parsed.tracks.find((candidate) => candidate.trackType === 1);
  if (!track) throw new Error('WebM file has no video track');
  if (track.codecId !== 'V_VP9') {
    throw new Error(`unsupported codec "${track.codecId}"; fixture pipeline emits VP9`);
  }
  return track;
}

function makeDecoderConfig(track) {
  return {
    codec: VP9_CODEC,
    codedWidth: track.width ?? undefined,
    codedHeight: track.height ?? undefined,
    optimizeForLatency: true
  };
}

async function rasterize(frame, thumbnailWidth) {
  // VP9 rounds coded dimensions up for subsampling; displayWidth/Height carry
  // the real visible rectangle and must drive the thumbnail aspect ratio.
  const sourceWidth = frame.displayWidth ?? frame.codedWidth;
  const sourceHeight = frame.displayHeight ?? frame.codedHeight;
  const scale = thumbnailWidth / sourceWidth;
  const thumbnailHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = new OffscreenCanvas(thumbnailWidth, thumbnailHeight);
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, sourceWidth, sourceHeight, 0, 0, thumbnailWidth, thumbnailHeight);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const imageBitmap = await createImageBitmap(blob);
  return { blob, imageBitmap, width: thumbnailWidth, height: thumbnailHeight };
}

// Wrap a VideoDecoder so every decoded frame is matched back to its chunk by
// PTS through a pending map. reset() rejects everything still pending, which
// is exactly what the abort path needs.
function createManagedDecoder(config) {
  const pending = new Map();
  let fatalError = null;
  const decoder = new VideoDecoder({
    output(frame) {
      const waiter = pending.get(frame.timestamp);
      if (waiter) {
        pending.delete(frame.timestamp);
        waiter.resolve(frame);
      } else {
        frame.close();
      }
    },
    error(error) {
      fatalError = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    }
  });

  return {
    async configure() {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        throw new Error(`VP9 config not supported: ${JSON.stringify(config)}`);
      }
      decoder.configure(config);
    },
    decode(chunk) {
      if (fatalError) return Promise.reject(fatalError);
      return new Promise((resolve, reject) => {
        pending.set(chunk.timestamp, { resolve, reject });
        try {
          decoder.decode(chunk);
        } catch (error) {
          pending.delete(chunk.timestamp);
          reject(error);
        }
      });
    },
    reset() {
      decoder.reset();
      for (const waiter of pending.values()) {
        waiter.reject(new AbortError('decoder reset'));
      }
      pending.clear();
    },
    close() {
      if (decoder.state !== 'closed') decoder.close();
    },
    get queueSize() {
      return decoder.decodeQueueSize;
    },
    get state() {
      return decoder.state;
    }
  };
}

export async function generateThumbnailWall(buffer, options = {}) {
  const {
    concurrency = 2,
    thumbnailWidth = 160,
    signal,
    frameRegistry = new FrameRegistry(),
    statsSink = null
  } = options;

  if (signal?.aborted) throw new AbortError();

  const parsed = parseWebm(buffer);
  const track = pickVideoTrack(parsed);
  const resolved = resolveChapterFrames(parsed.chapters, parsed.frames);

  // Flatten the chosen frames into a decode job list while remembering where
  // each result belongs in the chapter/slot grid.
  const jobs = [];
  resolved.forEach((chapterEntry) => {
    chapterEntry.thumbnails.forEach((thumbnail) => {
      jobs.push({ chapterEntry, thumbnail });
    });
  });

  const inFlight = { count: 0, max: 0 };
  const decoder = createManagedDecoder(makeDecoderConfig(track));
  await decoder.configure();

  const recordStats = () => {
    if (statsSink) {
      statsSink.maxInFlight = Math.max(statsSink.maxInFlight ?? 0, inFlight.max);
      statsSink.decodeQueueSize = decoder.queueSize;
      statsSink.registry = frameRegistry.snapshot();
    }
  };

  try {
    await runPool(
      jobs,
      concurrency,
      async (job) => {
        if (signal?.aborted) throw new AbortError();

        const chunk = new EncodedVideoChunk({
          type: job.thumbnail.keyframe ? 'key' : 'delta',
          timestamp: job.thumbnail.ptsMs * 1000, // microseconds
          data: job.thumbnail.data
        });

        inFlight.count++;
        inFlight.max = Math.max(inFlight.max, inFlight.count);
        recordStats();

        let frame;
        try {
          frame = await decoder.decode(chunk);
          frameRegistry.register(frame);
          const image = await rasterize(frame, thumbnailWidth);
          frameRegistry.release(frame);
          frame = null;
          job.result = {
            slot: job.thumbnail.slot,
            ptsMs: job.thumbnail.ptsMs,
            targetPtsMs: job.thumbnail.targetPtsMs,
            keyframe: job.thumbnail.keyframe,
            blob: image.blob,
            imageBitmap: image.imageBitmap,
            width: image.width,
            height: image.height
          };
        } finally {
          if (frame) frameRegistry.release(frame);
          inFlight.count--;
          recordStats();
        }
      },
      signal
    );
  } catch (error) {
    decoder.reset();
    const releasedOnAbort = frameRegistry.releaseAll();
    if (statsSink) statsSink.releasedOnAbort = releasedOnAbort;
    if (signal?.aborted) throw new AbortError(error.message);
    throw error;
  } finally {
    decoder.close();
    recordStats();
  }

  const chapterResults = resolved.map((chapterEntry) => ({
    chapterIndex: chapterEntry.chapterIndex,
    title: chapterEntry.chapter.title,
    startMs: chapterEntry.chapter.startMs,
    endMs: chapterEntry.chapter.endMs,
    thumbnails: chapterEntry.thumbnails.map((thumbnail) => {
      const job = jobs.find(
        (candidate) =>
          candidate.chapterEntry === chapterEntry &&
          candidate.thumbnail === thumbnail
      );
      return job.result;
    })
  }));

  return {
    source: {
      durationMs: parsed.durationMs,
      timestampScale: parsed.timestampScale,
      width: track.width,
      height: track.height
    },
    chapters: chapterResults,
    stats: {
      concurrency,
      maxInFlight: inFlight.max,
      registry: frameRegistry.snapshot()
    }
  };
}
