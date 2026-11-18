/* Canvas timeline: waveform, labeled segments, draggable boundaries. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Timeline = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const COLORS = {
    speech: "rgba(46, 134, 222, 0.30)",
    noise: "rgba(243, 156, 18, 0.30)",
    silence: "rgba(149, 165, 166, 0.22)",
    edge: "rgba(30, 40, 55, 0.85)",
    wave: "rgba(40, 55, 75, 0.75)",
    hover: "rgba(20, 30, 45, 1)"
  };

  function Timeline(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.segments = [];
    this.samples = null;
    this.duration = 0;
    this.onChange = (opts && opts.onChange) || function () {};
    this.hoverEdge = null;
    this.drag = null;
    this.playhead = 0;
    this._bind();
  }

  Timeline.prototype.setData = function (samples, duration, segments) {
    this.samples = samples;
    this.duration = duration;
    this.segments = segments.map((s) => Object.assign({}, s));
    this.draw();
  };

  Timeline.prototype.setSegments = function (segments) {
    this.segments = segments.map((s) => Object.assign({}, s));
    this.draw();
  };

  Timeline.prototype.setPlayhead = function (t) {
    this.playhead = t;
    this.draw();
  };

  Timeline.prototype._xToTime = function (x) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, (x - rect.left) / rect.width * this.duration));
  };

  Timeline.prototype._timeToX = function (t) {
    const rect = this.canvas.getBoundingClientRect();
    return (t / this.duration) * rect.width;
  };

  Timeline.prototype._edgeAt = function (x) {
    const rect = this.canvas.getBoundingClientRect();
    const px = x - rect.left;
    const tol = 6;
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      const ex = this._timeToX(s.end);
      if (Math.abs(ex - px) <= tol) return { index: i, which: "end" };
      const sx = this._timeToX(s.start);
      if (Math.abs(sx - px) <= tol) return { index: i, which: "start" };
    }
    return null;
  };

  Timeline.prototype._bind = function () {
    const c = this.canvas;
    c.addEventListener("mousemove", (e) => {
      if (this.drag) {
        this._applyDrag(e.clientX);
        return;
      }
      this.hoverEdge = this._edgeAt(e.clientX);
      c.style.cursor = this.hoverEdge ? "ew-resize" : "default";
      this.draw();
    });
    c.addEventListener("mousedown", (e) => {
      const edge = this._edgeAt(e.clientX);
      if (!edge) return;
      this.drag = edge;
      e.preventDefault();
    });
    window.addEventListener("mouseup", () => {
      if (this.drag) {
        this.drag = null;
        this.onChange(this.segments);
      }
    });
    c.addEventListener("touchstart", (e) => {
      const edge = this._edgeAt(e.touches[0].clientX);
      if (!edge) return;
      this.drag = edge;
      e.preventDefault();
    }, { passive: false });
    c.addEventListener("touchmove", (e) => {
      if (!this.drag) return;
      this._applyDrag(e.touches[0].clientX);
      e.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", () => {
      if (this.drag) {
        this.drag = null;
        this.onChange(this.segments);
      }
    });
    c.addEventListener("mouseleave", () => { this.hoverEdge = null; this.draw(); });
  };

  Timeline.prototype._applyDrag = function (clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const t = this._xToTime(clientX);
    const { index, which } = this.drag;
    const segs = this.segments;
    const minDur = 0.02;
    if (which === "end") {
      const next = segs[index + 1];
      const upper = next ? next.end - minDur : this.duration;
      const lower = segs[index].start + minDur;
      const nt = Math.max(lower, Math.min(upper, t));
      if (next) next.start = nt;
      segs[index].end = nt;
    } else {
      const prev = segs[index - 1];
      const lower = prev ? prev.start + minDur : 0;
      const upper = segs[index].end - minDur;
      const nt = Math.max(lower, Math.min(upper, t));
      if (prev) prev.end = nt;
      segs[index].start = nt;
    }
    this.draw();
    this.onChange(this.segments, true);
  };

  Timeline.prototype.draw = function () {
    const { ctx, canvas } = this;
    const w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    const h = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    if (!this.duration) return;
    const scale = w / this.duration;
    for (const s of this.segments) {
      ctx.fillStyle = COLORS[s.label] || COLORS.silence;
      ctx.fillRect(s.start * scale, 0, Math.max(1, (s.end - s.start) * scale), h);
    }
    this._drawWaveform(w, h, scale);
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      const x = s.end * scale;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (this.hoverEdge && this.hoverEdge.index === i) {
        ctx.strokeStyle = COLORS.hover;
        ctx.beginPath();
        const hx = (this.hoverEdge.which === "end" ? s.end : s.start) * scale;
        ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke();
        ctx.strokeStyle = COLORS.edge;
      }
    }
    ctx.strokeStyle = "#e74c3c";
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    const px = this.playhead * scale;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  };

  Timeline.prototype._drawWaveform = function (w, h, scale) {
    if (!this.samples) return;
    const ctx = this.ctx;
    const sr = this._sampleRate || 16000;
    const bucket = Math.max(1, Math.floor((this.duration * sr) / w));
    ctx.strokeStyle = COLORS.wave;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const start = x * bucket;
      let min = 1, max = -1;
      for (let i = start; i < start + bucket && i < this.samples.length; i++) {
        const v = this.samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yMid = h / 2;
      ctx.moveTo(x, yMid + min * h * 0.45);
      ctx.lineTo(x, yMid + max * h * 0.45);
    }
    ctx.stroke();
  };

  Timeline.COLORS = COLORS;
  return Timeline;
});
