(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MseAbrPlayer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function createPlayer({ video, manifest, abr, network, logger }) {
    const segmentDuration = manifest.segmentSeconds;
    let sourceBuffer = null;
    let appendedRendition = null;
    let initCache = new Map();
    let nextSegment = 0;
    let downloading = false;
    let ended = false;
    let stallCount = 0;
    let wasWaiting = false;
    let playbackStarted = false;
    const appended = [];

    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);

    video.addEventListener('playing', () => {
      playbackStarted = true;
      if (wasWaiting) {
        stallCount += 1;
        wasWaiting = false;
        logger({ type: 'stall', stallCount, at: video.currentTime });
      }
    });

    video.addEventListener('waiting', () => {
      if (!ended && playbackStarted && video.readyState >= 2) {
        wasWaiting = true;
      }
    });

    function bufferedEnd() {
      if (!sourceBuffer || sourceBuffer.buffered.length === 0) return 0;
      return sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    }

    function bufferAhead() {
      return Math.max(0, bufferedEnd() - video.currentTime);
    }

    async function loadInit(renditionId) {
      if (initCache.has(renditionId)) return initCache.get(renditionId);
      const rendition = manifest.renditions.find((item) => item.id === renditionId);
      const { buffer } = await network.fetch(rendition.init);
      initCache.set(renditionId, buffer);
      return buffer;
    }

    function appendBuffer(buffer) {
      return new Promise((resolve, reject) => {
        const onUpdateEnd = () => {
          sourceBuffer.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          reject(sourceBuffer.error || new Error('SourceBuffer append error'));
        };
        sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true });
        sourceBuffer.addEventListener('error', onError, { once: true });
        sourceBuffer.appendBuffer(buffer);
      });
    }

    async function pump() {
      if (downloading || ended) return;
      if (mediaSource.readyState !== 'open') return;
      if (nextSegment >= manifest.renditions[0].segments.length) return;
      if (bufferAhead() >= segmentDuration * 4) return;

      downloading = true;
      try {
        const segmentIndex = nextSegment;
        const decision = abr.decide(segmentIndex, bufferAhead());
        const rendition = manifest.renditions.find((item) => item.id === decision.rendition);
        if (!rendition) throw new Error(`unknown rendition ${decision.rendition}`);
        const segment = rendition.segments[segmentIndex];

        if (appendedRendition !== rendition.id) {
          const init = await loadInit(rendition.id);
          if (appendedRendition !== rendition.id) {
            await appendBuffer(init);
            appendedRendition = rendition.id;
            logger({ type: 'rendition-init', rendition: rendition.id, segmentIndex });
          }
        }

        const { buffer, elapsedMs, effectiveBps } = await network.fetch(segment.url);
        const measuredBps = effectiveBps || segment.bytes * 8 / Math.max(0.001, (elapsedMs || 40) / 1000);
        abr.reportFetch(segment.bytes, segment.bytes / (measuredBps / 8));
        const reportedElapsedMs = Math.round((segment.bytes * 8 * 1000) / measuredBps);

        await appendBuffer(buffer);
        appended.push({
          segmentIndex,
          rendition: rendition.id,
          bitrate: rendition.bitrate,
          reason: decision.reason,
          elapsedMs: reportedElapsedMs,
          effectiveBps: Math.round(effectiveBps || 0),
          atVideoTime: Math.round(video.currentTime * 100) / 100,
        });
        logger({ type: 'segment-appended', ...appended[appended.length - 1], decision });
        nextSegment += 1;

        if (nextSegment >= manifest.renditions[0].segments.length) {
          ended = true;
          if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
          }
          logger({ type: 'end-of-stream' });
        }
      } finally {
        downloading = false;
      }
      pump();
    }

    function onSourceOpen() {
      sourceBuffer = mediaSource.addSourceBuffer(manifest.videoMimeType);
      sourceBuffer.mode = 'segments';
      video.addEventListener('timeupdate', () => pump());
      video.addEventListener('progress', () => pump());
      pump();
    }

    mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });

    return {
      play: () => video.play(),
      pump,
      getStats: () => ({
        currentTime: video.currentTime,
        bufferedEnd: bufferedEnd(),
        bufferAhead: Math.round(bufferAhead() * 100) / 100,
        nextSegment,
        stallCount,
        ended,
        appended: appended.slice(),
        readyState: video.readyState,
      }),
    };
  }

  return { createPlayer };
});
