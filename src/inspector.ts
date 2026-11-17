import {
  assertDecoderSupport,
  detectBrowserCapabilities,
  missingWebCodecsCapabilities,
  type BrowserCapabilities,
} from "./media/capabilities";
import { decodeFrameAt, type DecodeResult } from "./media/decoder";
import { demuxFile } from "./media/demux";
import { frameAtOrBefore } from "./media/normalize";
import {
  InspectionError,
  type FrameSample,
  type VideoSource,
} from "./media/types";

interface Selection {
  inFrame?: FrameSample;
  outFrame?: FrameSample;
}

interface ManifestFrame {
  frameNumber: number;
  decodeIndex: number;
  ptsUs: number;
  ptsSeconds: number;
  durationUs: number;
  keyframe: boolean;
}

interface Manifest {
  tool: string;
  generatedAt: string;
  file: {
    name: string;
    size: number;
    type: string;
    container: string;
    codec: string;
    codecLabel: string;
    codedWidth: number;
    codedHeight: number;
    rotation: number;
    variableFrameRate: boolean;
  };
  selection: {
    inFrame: number;
    outFrame: number;
    frameCount: number;
    durationUs: number;
  };
  frames: ManifestFrame[];
}

interface PendingRequest {
  id: number;
  kind: "time" | "frame";
  value: number;
}

export interface PublicInspectorState {
  ready: boolean;
  busy: boolean;
  error: string | null;
  fileName: string | null;
  container: string | null;
  codec: string | null;
  rotation: number;
  isVfr: boolean;
  totalFrames: number;
  frameNumber: number | null;
  frameIndex: number | null;
  ptsUs: number | null;
  ptsSeconds: number | null;
  keyframe: boolean | null;
  decodeStartFrameNumber: number | null;
  decodedChunks: number | null;
  durationUs: number | null;
  selection: {
    inFrame: number | null;
    outFrame: number | null;
    count: number;
  };
  manifest: Manifest | null;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`缺少 DOM 元素 #${id}`);
  return found as T;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function errorToInspectionError(error: unknown): InspectionError {
  if (error instanceof InspectionError) return error;
  return new InspectionError(
    "decode",
    error instanceof Error ? error.message : String(error),
  );
}

export class FrameInspectorApp {
  private readonly capabilities: BrowserCapabilities =
    detectBrowserCapabilities();
  private readonly fileInput = element<HTMLInputElement>("fileInput");
  private readonly viewer = element<HTMLDivElement>("viewer");
  private readonly canvas = element<HTMLCanvasElement>("frameCanvas");
  private readonly emptyState = element<HTMLDivElement>("emptyState");
  private readonly decodeShade = element<HTMLDivElement>("decodeShade");
  private readonly decodeShadeText = element<HTMLSpanElement>("decodeShadeText");
  private readonly slider = element<HTMLInputElement>("timelineSlider");
  private readonly timeline = element<HTMLDivElement>("timeline");
  private readonly rangeFill = element<HTMLDivElement>("rangeFill");
  private readonly keyframeTicks = element<HTMLDivElement>("keyframeTicks");
  private readonly inMarker = element<HTMLDivElement>("inMarker");
  private readonly outMarker = element<HTMLDivElement>("outMarker");
  private readonly errorPanel = element<HTMLElement>("errorPanel");
  private readonly errorMessage = element<HTMLParagraphElement>("errorMessage");
  private readonly missingList = element<HTMLUListElement>("missingList");
  private readonly manifestButton = element<HTMLButtonElement>("manifestButton");
  private readonly manifestEmpty = element<HTMLDivElement>("manifestEmpty");
  private readonly manifestPreview = element<HTMLDivElement>("manifestPreview");
  private readonly manifestText = element<HTMLElement>("manifestText");
  private readonly downloadButton =
    element<HTMLButtonElement>("downloadManifestButton");

  private source?: VideoSource;
  private fileInfo?: File;
  private current?: DecodeResult;
  private selection: Selection = {};
  private manifest?: Manifest;
  private pending?: PendingRequest;
  private running = false;
  private requestId = 0;
  private waiters: Array<() => void> = [];
  private lastError: InspectionError | null = null;

  constructor() {
    this.renderCapabilities();
    this.bindEvents();
    this.updateControls();
  }

  private bindEvents(): void {
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.loadFile(file);
      this.fileInput.value = "";
    });

    this.slider.addEventListener("input", () => {
      this.setTimelineLabel(Number(this.slider.value) / 1000);
      void this.seekToTimeMs(Number(this.slider.value));
    });

    element<HTMLButtonElement>("prevFrameButton").addEventListener("click", () => {
      void this.stepFrame(-1);
    });
    element<HTMLButtonElement>("nextFrameButton").addEventListener("click", () => {
      void this.stepFrame(1);
    });
    element<HTMLButtonElement>("firstFrameButton").addEventListener("click", () => {
      void this.seekToFrameIndex(0);
    });
    element<HTMLButtonElement>("lastFrameButton").addEventListener("click", () => {
      if (this.source) void this.seekToFrameIndex(this.source.frames.length - 1);
    });
    element<HTMLButtonElement>("prevKeyButton").addEventListener("click", () => {
      this.seekToAdjacentKeyframe(-1);
    });
    element<HTMLButtonElement>("nextKeyButton").addEventListener("click", () => {
      this.seekToAdjacentKeyframe(1);
    });

    element<HTMLButtonElement>("markInButton").addEventListener("click", () => {
      this.markPoint("in");
    });
    element<HTMLButtonElement>("markOutButton").addEventListener("click", () => {
      this.markPoint("out");
    });
    this.manifestButton.addEventListener("click", () => this.generateManifest());
    this.downloadButton.addEventListener("click", () => this.downloadManifest());

    window.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        void this.stepFrame(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void this.stepFrame(1);
      } else if (event.key.toLowerCase() === "i") {
        this.markPoint("in");
      } else if (event.key.toLowerCase() === "o") {
        this.markPoint("out");
      }
    });

    for (const name of ["dragenter", "dragover"]) {
      this.viewer.addEventListener(name, (event) => {
        event.preventDefault();
        this.viewer.classList.add("is-dragging");
      });
    }
    for (const name of ["dragleave", "drop"]) {
      this.viewer.addEventListener(name, (event) => {
        event.preventDefault();
        this.viewer.classList.remove("is-dragging");
      });
    }
    this.viewer.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files[0];
      if (file) void this.loadFile(file);
    });
  }

  private renderCapabilities(): void {
    const missing = missingWebCodecsCapabilities(this.capabilities);
    const items = [
      ["安全上下文", this.capabilities.secureContext, "isSecureContext"],
      ["VideoDecoder", this.capabilities.videoDecoder, "WebCodecs"],
      [
        "EncodedVideoChunk",
        this.capabilities.encodedVideoChunk,
        "WebCodecs",
      ],
      ["VideoFrame", this.capabilities.videoFrame, "WebCodecs"],
      ["Canvas 2D", this.capabilities.canvas2d, "Rendering"],
    ] as const;
    element<HTMLUListElement>("capabilityList").innerHTML = items
      .map(
        ([label, ok, code]) => `
          <li class="capability-item ${ok ? "" : "is-missing"}">
            <i></i><span>${label}</span><code>${ok ? code : "缺失"}</code>
          </li>`,
      )
      .join("");

    const pill = element<HTMLDivElement>("capabilityPill");
    const badge = element<HTMLSpanElement>("runtimeBadge");
    if (missing.length === 0) {
      pill.className = "capability-pill is-ready";
      badge.className = "status-chip is-ready";
      pill.querySelector("span")!.textContent = "WebCodecs 就绪";
      badge.textContent = "可用";
      if (!this.capabilities.secureContext) this.showCapabilityWarning(missing);
    } else {
      pill.className = "capability-pill is-failed";
      badge.className = "status-chip is-failed";
      pill.querySelector("span")!.textContent = "能力不完整";
      badge.textContent = "不可用";
      this.showCapabilityWarning(missing);
    }
  }

  private showCapabilityWarning(missing: string[]): void {
    const warning = element<HTMLDivElement>("capabilityWarning");
    warning.classList.remove("is-hidden");
    warning.textContent = `缺少：${missing.join("、")}。请使用最新版 Chrome / Edge，并通过 HTTPS 或 localhost 打开。`;
  }

  async loadFile(file: File): Promise<void> {
    this.clearError();
    this.setStatus("正在读取容器与轨道…", "busy");
    this.setBusy(true, "解析容器");
    try {
      const source = await demuxFile(file);
      await assertDecoderSupport(source);
      this.source = source;
      this.fileInfo = file;
      this.current = undefined;
      this.selection = {};
      this.manifest = undefined;
      this.pending = undefined;
      this.requestId += 1;
      this.applySourceUI(file, source);
      this.setStatus(
        `已载入 ${source.frames.length} 帧 · 从关键帧开始解码`,
        "ready",
      );
      await this.enqueue({ kind: "frame", value: 0 });
    } catch (error) {
      const failure = errorToInspectionError(error);
      this.showError(failure);
      this.setStatus(failure.message, "error");
    } finally {
      this.setBusy(false);
      this.updateControls();
    }
  }

  private applySourceUI(file: File, source: VideoSource): void {
    this.emptyState.classList.add("is-hidden");
    element<HTMLSpanElement>("fileName").textContent = file.name;
    element<HTMLSpanElement>("fileSize").textContent = formatBytes(file.size);
    element<HTMLSpanElement>("hdrBadge").textContent =
      source.container === "mp4" ? "ISO BMFF" : "MATROSKA";
    element<HTMLSpanElement>("hdrBadge").classList.add("is-live");
    const vfrBadge = element<HTMLSpanElement>("vfrBadge");
    vfrBadge.classList.toggle("is-hidden", !source.isVfr);
    if (source.isVfr) vfrBadge.classList.add("is-live");

    this.slider.disabled = false;
    this.slider.max = String(Math.max(1, Math.round(source.durationUs / 1000)));
    this.slider.value = "0";
    this.setTimelineLabel(0);
    element<HTMLSpanElement>("timelineDuration").textContent = formatClock(
      source.durationUs / 1_000_000,
    );
    element<HTMLSpanElement>("transportTotal").textContent = String(
      source.frames.length,
    );
    this.renderKeyframeTicks();
    this.renderMediaMetadata(file, source);
  }

  private renderKeyframeTicks(): void {
    if (!this.source) return;
    const fragment = document.createDocumentFragment();
    for (const frame of this.source.frames) {
      if (!frame.isKey) continue;
      const tick = document.createElement("i");
      tick.className = "keyframe-tick";
      tick.style.left = `${(frame.timestampUs / this.source.durationUs) * 100}%`;
      fragment.append(tick);
    }
    this.keyframeTicks.replaceChildren(fragment);
  }

  private renderMediaMetadata(file: File, source: VideoSource): void {
    const timing = source.isVfr
      ? `VFR · ${(source.minFrameDurationUs / 1000).toFixed(1)}–${(source.maxFrameDurationUs / 1000).toFixed(1)} ms`
      : `CFR · ${source.averageFps.toFixed(2)} fps`;
    const rows: Array<[string, string, boolean?]> = [
      ["容器", `${source.container.toUpperCase()} · ${formatBytes(file.size)}`],
      ["编解码器", `${source.codecLabel} · ${source.codec}`, true],
      [
        "画面尺寸",
        `${source.codedWidth}×${source.codedHeight} → ${source.displayWidth}×${source.displayHeight}`,
      ],
      [
        "旋转元数据",
        `${source.rotation}°${source.rotation ? " · Display Matrix" : ""}`,
        Boolean(source.rotation),
      ],
      ["帧率结构", timing, source.isVfr],
      ["总帧数", `${source.frames.length} 帧`],
      ["时长", formatClock(source.durationUs / 1_000_000)],
    ];
    element<HTMLDListElement>("mediaMeta").innerHTML = rows
      .map(
        ([label, value, accent]) =>
          `<div><dt>${label}</dt><dd class="${accent ? "is-accent" : ""}">${value}</dd></div>`,
      )
      .join("");
  }

  private setBusy(busy: boolean, text = "解码中"): void {
    this.decodeShade.classList.toggle("is-visible", busy);
    this.decodeShadeText.textContent = text;
    if (busy) this.setStatus(`${text} · 从最近关键帧重建解码窗口`, "busy");
  }

  private setStatus(text: string, state: "ready" | "busy" | "error"): void {
    element<HTMLSpanElement>("statusText").textContent = text;
    const dot = element<HTMLSpanElement>("statusDot");
    dot.className = `status-dot ${state === "busy" ? "is-busy" : state === "error" ? "is-error" : ""}`;
  }

  private updateControls(): void {
    const hasSource = Boolean(this.source);
    const currentIndex = this.current?.target.presentationIndex ?? -1;
    const total = this.source?.frames.length ?? 0;
    const busy = this.running;
    const selection = this.selectedFrames();
    const setDisabled = (id: string, disabled: boolean) => {
      element<HTMLButtonElement>(id).disabled = disabled;
    };

    setDisabled("firstFrameButton", !hasSource || busy || currentIndex <= 0);
    setDisabled(
      "prevFrameButton",
      !hasSource || busy || currentIndex <= 0,
    );
    setDisabled(
      "nextFrameButton",
      !hasSource || busy || currentIndex >= total - 1,
    );
    setDisabled(
      "lastFrameButton",
      !hasSource || busy || currentIndex >= total - 1,
    );
    this.updateKeyframeButton("prevKeyButton", -1, !hasSource || busy);
    this.updateKeyframeButton("nextKeyButton", 1, !hasSource || busy);
    setDisabled("markInButton", !hasSource || !this.current || busy);
    setDisabled("markOutButton", !hasSource || !this.current || busy);
    this.manifestButton.disabled =
      !hasSource || busy || !selection.inFrame || !selection.outFrame;
    this.slider.disabled = !hasSource;
  }

  private updateKeyframeButton(
    id: string,
    direction: -1 | 1,
    baseDisabled: boolean,
  ): void {
    const target = this.adjacentKeyframe(direction);
    element<HTMLButtonElement>(id).disabled = baseDisabled || !target;
  }

  private enqueue(request: Omit<PendingRequest, "id">): Promise<void> {
    if (!this.source) return Promise.resolve();
    const pending: PendingRequest = { ...request, id: ++this.requestId };
    this.pending = pending;
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    if (!this.running) void this.drain();
    return done;
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.updateControls();
    this.setBusy(true);
    while (this.pending) {
      const request = this.pending;
      this.pending = undefined;
      await this.performRequest(request);
    }
    this.running = false;
    this.setBusy(false);
    this.updateControls();
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private async performRequest(request: PendingRequest): Promise<void> {
    if (!this.source) return;
    const target =
      request.kind === "frame"
        ? this.source.frames[request.value]
        : frameAtOrBefore(this.source, request.value);
    if (!target) return;

    this.decodeShadeText.textContent = `解码至帧 #${target.presentationIndex + 1}`;
    try {
      const result = await decodeFrameAt(this.source, target);
      if (request.id !== this.requestId || this.pending) {
        result.frame.close();
        return;
      }
      this.applyDecodeResult(result);
      this.lastError = null;
      this.setStatus(
        `帧 #${target.presentationIndex + 1} · PTS ${target.timestampUs} µs · 解码 ${result.decodedChunks} 块`,
        "ready",
      );
      this.clearError();
    } catch (error) {
      const failure = errorToInspectionError(error);
      this.showError(failure);
      this.setStatus(failure.message, "error");
      this.pending = undefined;
    }
  }

  private applyDecodeResult(result: DecodeResult): void {
    if (!this.source) return;
    if (this.current) this.current.frame.close();
    this.current = result;
    this.drawFrame(result.frame);

    const frame = result.target;
    const startFrame =
      this.source.frames.find(
        (candidate) => candidate.decodeIndex === result.start.decodeIndex,
      ) ?? null;
    const startNumber = startFrame?.presentationIndex ?? -1;
    const frameNumber = frame.presentationIndex + 1;

    element<HTMLElement>("frameIndexValue").textContent = `#${frameNumber}`;
    element<HTMLElement>("frameIndexSub").textContent =
      `${frameNumber} / ${this.source.frames.length} · decode #${frame.decodeIndex + 1}`;
    element<HTMLElement>("ptsValue").textContent =
      `${(frame.timestampUs / 1_000_000).toFixed(6)} s`;
    element<HTMLElement>("ptsSub").textContent =
      `${frame.timestampUs} µs · raw ${frame.rawTimestamp ?? "—"}`;
    element<HTMLElement>("keyframeValue").textContent = frame.isKey
      ? "关键帧"
      : "非关键帧";
    element<HTMLElement>("keyframeValue").classList.toggle(
      "is-key",
      frame.isKey,
    );
    element<HTMLElement>("keyframeSub").textContent = frame.isKey
      ? "sync sample / IDR"
      : "delta frame · 依赖参考帧";
    element<HTMLElement>("decodeCountValue").textContent =
      `${result.decodedChunks} 块`;
    element<HTMLElement>("decodeCountSub").textContent =
      startNumber >= 0
        ? `从关键帧 #${startNumber + 1} 起`
        : `decode #${result.start.decodeIndex + 1} 起`;

    element<HTMLSpanElement>("hudFrame").textContent =
      `FRAME ${String(frameNumber).padStart(4, "0")}`;
    element<HTMLSpanElement>("hudPts").textContent =
      `PTS ${frame.timestampUs} µs`;
    const keyHud = element<HTMLSpanElement>("hudKey");
    keyHud.textContent = frame.isKey ? "KEY" : "DELTA";
    keyHud.classList.toggle("is-delta", !frame.isKey);
    element<HTMLSpanElement>("transportFrame").textContent = String(frameNumber);

    const decodeRange = startNumber >= 0
      ? `关键帧 #${startNumber + 1} → 帧 #${frameNumber} · ${result.decodedChunks} 块`
      : `decode #${result.start.decodeIndex + 1} → 帧 #${frameNumber}`;
    element<HTMLSpanElement>("decodeRange").textContent = decodeRange;
    const timing = this.source.isVfr ? "VFR" : "CFR";
    element<HTMLSpanElement>("timingLabel").textContent =
      `${timing} · ${frame.durationUs.toFixed(0)} µs 显示间隔`;

    this.slider.value = String(
      Math.min(Number(this.slider.max), Math.round(frame.timestampUs / 1000)),
    );
    this.setTimelineLabel(frame.timestampUs / 1_000_000);
    this.selectionSummary();
    this.updateControls();
  }

  private drawFrame(frame: VideoFrame): void {
    if (!this.source) return;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      this.showError(
        new InspectionError(
          "capability",
          "无法创建 Canvas 2D 上下文。",
          ["Canvas 2D"],
        ),
      );
      return;
    }

    const baseWidth = frame.displayWidth || frame.codedWidth;
    const baseHeight = frame.displayHeight || frame.codedHeight;
    const quarterTurn =
      this.source.rotation === 90 || this.source.rotation === 270;
    this.canvas.width = quarterTurn ? baseHeight : baseWidth;
    this.canvas.height = quarterTurn ? baseWidth : baseHeight;
    context.save();
    context.fillStyle = "#000";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.translate(this.canvas.width / 2, this.canvas.height / 2);
    context.rotate((this.source.rotation * Math.PI) / 180);
    context.drawImage(
      frame,
      -baseWidth / 2,
      -baseHeight / 2,
      baseWidth,
      baseHeight,
    );
    context.restore();
  }

  private setTimelineLabel(seconds: number): void {
    element<HTMLSpanElement>("timelineCurrent").textContent = formatClock(seconds);
    const max = Math.max(1, Number(this.slider.max));
    const progress = Math.min(100, (Number(this.slider.value) / max) * 100);
    this.timeline.style.setProperty("--progress", `${progress}%`);
    this.rangeFill.style.width = `${progress}%`;
    element<HTMLSpanElement>("timelineType").textContent =
      this.running ? "关键帧重建中" : "逐帧定位";
  }

  private async seekToTimeMs(timeMs: number): Promise<void> {
    if (!this.source) return;
    this.slider.value = String(
      Math.max(0, Math.min(Number(this.slider.max), timeMs)),
    );
    this.setTimelineLabel(timeMs / 1000);
    await this.enqueue({
      kind: "time",
      value: Math.max(0, Math.round(timeMs * 1000)),
    });
  }

  private async seekToFrameIndex(index: number): Promise<void> {
    if (!this.source) return;
    const clamped = Math.max(0, Math.min(this.source.frames.length - 1, index));
    const frame = this.source.frames[clamped];
    this.slider.value = String(Math.round(frame.timestampUs / 1000));
    this.setTimelineLabel(frame.timestampUs / 1_000_000);
    await this.enqueue({ kind: "frame", value: clamped });
  }

  private async stepFrame(delta: -1 | 1): Promise<void> {
    if (!this.source || this.running) return;
    const index = this.current?.target.presentationIndex;
    if (index === undefined) return;
    await this.seekToFrameIndex(index + delta);
  }

  private adjacentKeyframe(direction: -1 | 1): FrameSample | undefined {
    if (!this.source || !this.current) return undefined;
    const index = this.current.target.presentationIndex;
    if (direction < 0) {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (this.source.frames[cursor].isKey) return this.source.frames[cursor];
      }
    } else {
      for (
        let cursor = index + 1;
        cursor < this.source.frames.length;
        cursor += 1
      ) {
        if (this.source.frames[cursor].isKey) return this.source.frames[cursor];
      }
    }
    return undefined;
  }

  private seekToAdjacentKeyframe(direction: -1 | 1): void {
    const target = this.adjacentKeyframe(direction);
    if (target) void this.seekToFrameIndex(target.presentationIndex);
  }

  private markPoint(kind: "in" | "out"): void {
    if (!this.current) return;
    if (kind === "in") {
      this.selection.inFrame = this.current.target;
    } else {
      this.selection.outFrame = this.current.target;
    }
    this.manifest = undefined;
    this.selectionSummary();
    this.updateControls();
  }

  private selectedFrames(): { inFrame?: FrameSample; outFrame?: FrameSample } {
    const { inFrame, outFrame } = this.selection;
    if (
      inFrame &&
      outFrame &&
      inFrame.presentationIndex > outFrame.presentationIndex
    ) {
      return { inFrame: outFrame, outFrame: inFrame };
    }
    return this.selection;
  }

  private selectionSummary(): void {
    if (!this.source) return;
    const normalized = this.selectedFrames();
    const inNumber = normalized.inFrame
      ? normalized.inFrame.presentationIndex + 1
      : null;
    const outNumber = normalized.outFrame
      ? normalized.outFrame.presentationIndex + 1
      : null;

    this.inMarker.classList.toggle("is-hidden", !normalized.inFrame);
    this.outMarker.classList.toggle("is-hidden", !normalized.outFrame);
    if (normalized.inFrame) {
      const percent =
        (normalized.inFrame.timestampUs / this.source.durationUs) * 100;
      this.inMarker.style.setProperty("--in-pos", `${percent}%`);
      this.inMarker.style.left = `${percent}%`;
    }
    if (normalized.outFrame) {
      const percent =
        (normalized.outFrame.timestampUs / this.source.durationUs) * 100;
      this.outMarker.style.setProperty("--out-pos", `${percent}%`);
      this.outMarker.style.left = `${percent}%`;
    }

    let text = "尚未标记帧范围";
    if (inNumber !== null && outNumber !== null) {
      const count = this.selectedFrames().outFrame!.presentationIndex -
        this.selectedFrames().inFrame!.presentationIndex + 1;
      text = `入点 #${inNumber} → 出点 #${outNumber} · 共 ${count} 帧`;
    } else if (inNumber !== null) {
      text = `入点 #${inNumber} 已标记 · 还需出点`;
    } else if (outNumber !== null) {
      text = `出点 #${outNumber} 已标记 · 还需入点`;
    }
    element<HTMLSpanElement>("selectionSummary").textContent = text;
  }

  private generateManifest(): void {
    if (!this.source || !this.fileInfo) return;
    const { inFrame, outFrame } = this.selectedFrames();
    if (!inFrame || !outFrame) return;
    const frames = this.source.frames
      .slice(inFrame.presentationIndex, outFrame.presentationIndex + 1)
      .map<ManifestFrame>((frame) => ({
        frameNumber: frame.presentationIndex + 1,
        decodeIndex: frame.decodeIndex,
        ptsUs: frame.timestampUs,
        ptsSeconds: Number((frame.timestampUs / 1_000_000).toFixed(6)),
        durationUs: frame.durationUs,
        keyframe: frame.isKey,
      }));

    this.manifest = {
      tool: "WebCodecs Frame Inspector",
      generatedAt: new Date().toISOString(),
      file: {
        name: this.fileInfo.name,
        size: this.fileInfo.size,
        type: this.fileInfo.type || "application/octet-stream",
        container: this.source.container,
        codec: this.source.codec,
        codecLabel: this.source.codecLabel,
        codedWidth: this.source.codedWidth,
        codedHeight: this.source.codedHeight,
        rotation: this.source.rotation,
        variableFrameRate: this.source.isVfr,
      },
      selection: {
        inFrame: inFrame.presentationIndex + 1,
        outFrame: outFrame.presentationIndex + 1,
        frameCount: frames.length,
        durationUs: this.source.durationUs,
      },
      frames,
    };

    this.manifestEmpty.classList.add("is-hidden");
    this.manifestPreview.classList.remove("is-hidden");
    element<HTMLElement>("manifestFrameCount").textContent = String(
      frames.length,
    );
    const spanUs =
      outFrame.timestampUs -
      inFrame.timestampUs +
      (outFrame.durationUs || 0);
    element<HTMLElement>("manifestSpan").textContent =
      `${(spanUs / 1_000_000).toFixed(3)} s`;
    element<HTMLElement>("manifestKeyCount").textContent =
      `${frames.filter((frame) => frame.keyframe).length} 关键帧`;
    const previewFrames = frames.slice(0, 10);
    const lines = previewFrames.map(
      (frame) =>
        `#${String(frame.frameNumber).padStart(4, "0")}  ${frame.ptsSeconds.toFixed(6)} s  ${frame.keyframe ? "KEY  " : "DELTA"}`,
    );
    if (frames.length > previewFrames.length) {
      lines.push(`… 另有 ${frames.length - previewFrames.length} 帧`);
    }
    this.manifestText.textContent = lines.join("\n");
    this.updateControls();
    this.setStatus(
      `已生成 ${frames.length} 帧清单 · 可下载 JSON`,
      "ready",
    );
  }

  private downloadManifest(): void {
    if (!this.manifest || !this.fileInfo) return;
    const blob = new Blob([JSON.stringify(this.manifest, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const baseName = this.fileInfo.name.replace(/\.[^.]+$/, "");
    anchor.href = url;
    anchor.download = `${baseName}.frames.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private showError(error: InspectionError): void {
    this.lastError = error;
    this.errorPanel.classList.remove("is-hidden");
    this.errorMessage.textContent = error.message;
    this.missingList.innerHTML = error.missing
      .map((item) => `<li>${item}</li>`)
      .join("");
    this.missingList.classList.toggle("is-hidden", error.missing.length === 0);
    const pill = element<HTMLDivElement>("capabilityPill");
    const badge = element<HTMLSpanElement>("runtimeBadge");
    if (error.kind === "capability") {
      pill.className = "capability-pill is-failed";
      badge.className = "status-chip is-failed";
      pill.querySelector("span")!.textContent = "能力不满足";
      badge.textContent = "能力缺失";
    }
    // Dispatch a custom event so browser-based tests and host pages can inspect failures.
    window.dispatchEvent(
      new CustomEvent("frame-inspector-error", { detail: this.getState() }),
    );
  }

  private clearError(): void {
    this.lastError = null;
    this.errorPanel.classList.add("is-hidden");
    const pill = element<HTMLDivElement>("capabilityPill");
    const badge = element<HTMLSpanElement>("runtimeBadge");
    if (missingWebCodecsCapabilities(this.capabilities).length === 0) {
      pill.className = "capability-pill is-ready";
      badge.className = "status-chip is-ready";
      pill.querySelector("span")!.textContent = "WebCodecs 就绪";
      badge.textContent = "可用";
    }
  }

  getState(): PublicInspectorState {
    const normalized = this.selectedFrames();
    const inIndex = normalized.inFrame?.presentationIndex ?? null;
    const outIndex = normalized.outFrame?.presentationIndex ?? null;
    return {
      ready: Boolean(this.source),
      busy: this.running || Boolean(this.pending),
      error: this.lastError?.message ?? null,
      fileName: this.fileInfo?.name ?? null,
      container: this.source?.container ?? null,
      codec: this.source?.codec ?? null,
      rotation: this.source?.rotation ?? 0,
      isVfr: this.source?.isVfr ?? false,
      totalFrames: this.source?.frames.length ?? 0,
      frameNumber: this.current
        ? this.current.target.presentationIndex + 1
        : null,
      frameIndex: this.current?.target.presentationIndex ?? null,
      ptsUs: this.current?.target.timestampUs ?? null,
      ptsSeconds: this.current
        ? this.current.target.timestampUs / 1_000_000
        : null,
      keyframe: this.current?.target.isKey ?? null,
      decodeStartFrameNumber:
        this.source && this.current
          ? (this.source.frames.find(
              (frame) => frame.decodeIndex === this.current!.start.decodeIndex,
            )?.presentationIndex ?? -1) + 1
          : null,
      decodedChunks: this.current?.decodedChunks ?? null,
      durationUs: this.source?.durationUs ?? null,
      selection: {
        inFrame: inIndex === null ? null : inIndex + 1,
        outFrame: outIndex === null ? null : outIndex + 1,
        count:
          inIndex !== null && outIndex !== null ? outIndex - inIndex + 1 : 0,
      },
      manifest: this.manifest ?? null,
    };
  }

  async seekToMs(timeMs: number): Promise<void> {
    await this.seekToTimeMs(timeMs);
  }

  async stepBy(delta: -1 | 1): Promise<void> {
    await this.stepFrame(delta);
  }

  mark(kind: "in" | "out"): void {
    this.markPoint(kind);
  }

  buildManifest(): void {
    this.generateManifest();
  }
}
