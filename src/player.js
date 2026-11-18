import { cueForSegment, playbackState } from "./timeline.js";

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${safe.toFixed(2)}s`;
}

export class CuePlayer {
  constructor({ video, source, model, onState, onLog, onError }) {
    this.video = video;
    this.source = source;
    this.model = model;
    this.onState = onState;
    this.onLog = onLog;
    this.onError = onError;
    this.hls = null;
    this.lastSegment = -1;
    this.lastPhase = null;
    this.logs = [];
    this.ready = false;
    this.bindMediaEvents();
    this.load();
  }

  bindMediaEvents() {
    const tick = () => this.publish();
    this.video.addEventListener("timeupdate", tick);
    this.video.addEventListener("seeked", tick);
    this.video.addEventListener("play", tick);
    this.video.addEventListener("pause", tick);
    this.video.addEventListener("ended", tick);
  }

  load() {
    if (window.Hls?.isSupported()) {
      this.hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30
      });
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        this.ready = true;
        this.publish();
        this.onState?.({ ...this.snapshot(), ready: true });
      });
      this.hls.on(window.Hls.Events.FRAG_CHANGED, (_event, data) => {
        this.handleFragment(data.frag);
      });
      this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        this.onError?.(data);
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
      });
      this.hls.loadSource(this.source);
      this.hls.attachMedia(this.video);
      return;
    }

    this.video.src = this.source;
    this.ready = true;
    this.video.addEventListener("loadedmetadata", () => {
      this.publish();
      this.onState?.({ ...this.snapshot(), ready: true });
    }, { once: true });
  }

  handleFragment(fragment) {
    const index = Number.isInteger(fragment?.sn)
      ? fragment.sn - (this.model.segments[0]?.sequence || 0)
      : this.model.segments.findIndex(segment => Math.abs(segment.start - fragment?.start) < 0.05);
    const segmentIndex = Math.max(0, Math.min(index, this.model.segments.length - 1));
    const segment = this.model.segments[segmentIndex];
    const cue = cueForSegment(this.model, segmentIndex);
    const mediaTime = segment?.start ?? fragment?.start ?? 0;
    if (this.lastSegment !== segmentIndex || !this.logs.length) {
      this.lastSegment = segmentIndex;
      const entry = {
        label: `#${String(segmentIndex).padStart(2, "0")} @ ${formatTime(mediaTime)}`,
        value: cue ? `${cue.id} · AD` : "CONTENT",
        isAd: Boolean(cue),
        mediaTime,
        segmentIndex,
        cueId: cue?.id || null
      };
      this.logs = [entry, ...this.logs].slice(0, 8);
      this.onLog?.(this.logs, entry);
    }
    this.publish();
  }

  snapshot() {
    const time = Number(this.video.currentTime) || 0;
    const state = playbackState(this.model, time);
    return {
      ready: this.ready,
      paused: this.video.paused,
      currentTime: time,
      duration: Number(this.video.duration) || this.model.totalDuration,
      phase: state.phase,
      label: state.label,
      cueId: state.cue?.id || null,
      segmentIndex: state.segment?.index ?? null,
      elapsed: state.elapsed,
      remaining: state.remaining,
      nextCue: state.nextCue ? { id: state.nextCue.id, start: state.nextCue.start } : null,
      previousCue: state.previousCue
        ? { id: state.previousCue.id, end: state.previousCue.end }
        : null,
      logs: this.logs
    };
  }

  publish() {
    const state = this.snapshot();
    if (state.phase !== this.lastPhase && this.lastPhase !== null) {
      const transition = {
        label: formatTime(state.currentTime),
        value: `${this.lastPhase.toUpperCase()} → ${state.phase.toUpperCase()}`,
        isAd: state.phase === "ad",
        mediaTime: state.currentTime,
        segmentIndex: state.segmentIndex,
        cueId: state.cueId
      };
      this.logs = [transition, ...this.logs].slice(0, 8);
      this.onLog?.(this.logs, transition);
    }
    this.lastPhase = state.phase;
    this.onState?.(state);
  }

  async play() {
    try {
      await this.video.play();
    } catch (error) {
      this.onError?.({ type: "PLAYBACK", details: error.message, fatal: false });
    }
  }

  pause() {
    this.video.pause();
  }

  async seek(time) {
    const target = Math.max(0, Math.min(Number(time) || 0, this.model.totalDuration - 0.05));
    if (this.video.readyState >= 1) {
      this.video.currentTime = target;
      return;
    }
    await new Promise(resolve => {
      this.video.addEventListener("loadedmetadata", () => {
        this.video.currentTime = target;
        resolve();
      }, { once: true });
    });
  }

  destroy() {
    this.hls?.destroy();
  }
}
