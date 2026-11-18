import type { KeyerParams, KeyerResult, RGB } from '../types';
import { FRAME_COUNT, FPS, generateFootage } from '../synthetic/scene';
import { autoSample, sampleBackground } from '../keying/sampling';
import { defaultParams, clearProtection, paintProtection } from '../keying/despill';
import { runKeyer } from '../keying/keyer';
import { measureDecodeError, measureSequence, type SequenceMetrics } from '../metrics/metrics';
import { decodeChunks, encodeVideo, isWebCodecsSupported } from '../codec/codec';
import { buildLayout } from './template';
import { renderMatte, renderOriginal, putFrame } from './render';
import { renderMetrics } from './metricsPanel';
import { rgbToCss } from '../keying/color';
import { compositeOverBackground, type BackgroundMode } from '../keying/composite';

type Mode = 'none' | 'sample' | 'protect';

export async function startApp(root: HTMLElement): Promise<void> {
  buildLayout(root);
  const frames = generateFootage();
  const width = frames[0].width;
  const height = frames[0].height;

  const $ = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`) as T;
  const canvasIds = ['cvOriginal', 'cvMatte', 'cvComposite'] as const;
  const contexts = new Map<string, CanvasRenderingContext2D>();
  for (const id of canvasIds) {
    const cv = $<HTMLCanvasElement>(id);
    cv.width = width;
    cv.height = height;
    contexts.set(id, cv.getContext('2d')!);
  }

  const params: KeyerParams = defaultParams(autoSample(frames[0]));
  const protect = new Uint8Array(width * height);
  let frameIndex = 0;
  let mode: Mode = 'none';
  let bgMode: BackgroundMode = 'checker';
  let sampleRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let results: KeyerResult[] = [];
  let seq: SequenceMetrics | null = null;
  let composited: Uint8ClampedArray[] = [];
  let playing = false;
  let playTimer: number | undefined;

  const solidBg: RGB = { r: 200, g: 40, b: 160 };

  const slider = $<HTMLInputElement>('frameSlider');
  slider.max = String(FRAME_COUNT - 1);

  function recompute(): void {
    results = frames.map((f) => runKeyer(f, params, protect));
    seq = measureSequence(frames, results);
    composited = results.map((r) =>
      compositeOverBackground(frames[0], r.despilled, bgMode, solidBg)
    );
    renderCurrent();
    renderMetrics($('metricsBox'), seq, frameIndex);
    updateWarning();
  }

  function renderCurrent(): void {
    const frame = frames[frameIndex];
    const result = results[frameIndex];
    renderOriginal(contexts.get('cvOriginal')!, frame, result, protect, sampleRect);
    renderMatte(contexts.get('cvMatte')!, frame, result, protect);
    putFrame(contexts.get('cvComposite')!, composited[frameIndex], width, height);
    $('frameLabel').textContent = `${frameIndex + 1} / ${FRAME_COUNT}`;
    if (seq) renderMetrics($('metricsBox'), seq, frameIndex);
  }

  function updateWarning(): void {
    const count = results[frameIndex].ambiguity.reduce((s, v) => s + v, 0);
    const box = $('warnBox');
    if (count > 0) {
      box.classList.add('show');
      box.textContent =
        `检测到 ${count} 个歧义像素：前景自身颜色接近绿幕，已保留 alpha 下限而非直接删除。` +
        '请用“涂抹保护”标记应保留的绿色前景。';
    } else {
      box.classList.remove('show');
    }
  }

  function syncControls(): void {
    $<HTMLInputElement>('tolerance').value = String(params.tolerance);
    $<HTMLInputElement>('softness').value = String(params.softness);
    $<HTMLInputElement>('despill').value = String(params.despill);
    $<HTMLInputElement>('ambiguityFloor').value = String(params.ambiguityFloor);
    $('tolVal').textContent = params.tolerance.toFixed(0);
    $('softVal').textContent = params.softness.toFixed(0);
    $('despillVal').textContent = params.despill.toFixed(2);
    $('floorVal').textContent = params.ambiguityFloor.toFixed(0);
    $('keyRgb').textContent =
      `rgb(${params.keyColor.r}, ${params.keyColor.g}, ${params.keyColor.b})`;
    $('swatch').style.background = rgbToCss(params.keyColor);
  }

  bindControls();
  syncControls();
  recompute();

  function bindControls(): void {
    const bindRange = (id: string, key: keyof KeyerParams, fmtId: string, digits = 0): void => {
      const el = $<HTMLInputElement>(id);
      el.addEventListener('input', () => {
        (params[key] as number) = Number(el.value);
        $(fmtId).textContent = (params[key] as number).toFixed(digits);
        scheduleRecompute();
      });
    };
    bindRange('tolerance', 'tolerance', 'tolVal');
    bindRange('softness', 'softness', 'softVal');
    bindRange('despill', 'despill', 'despillVal', 2);
    bindRange('ambiguityFloor', 'ambiguityFloor', 'floorVal');

    $('sampleBtn').addEventListener('click', () => {
      mode = mode === 'sample' ? 'none' : 'sample';
      $('sampleBtn').classList.toggle('active', mode === 'sample');
    });
    $('autoBtn').addEventListener('click', () => {
      params.keyColor = autoSample(frames[frameIndex]);
      sampleRect = null;
      syncControls();
      recompute();
    });
    $('protectBtn').addEventListener('click', () => {
      mode = mode === 'protect' ? 'none' : 'protect';
      $('protectBtn').classList.toggle('active', mode === 'protect');
    });
    $('clearProtectBtn').addEventListener('click', () => {
      clearProtection(protect);
      recompute();
    });
    $('bgMode').addEventListener('change', (e) => {
      bgMode = (e.target as HTMLSelectElement).value as BackgroundMode;
      recompute();
    });
    slider.addEventListener('input', () => {
      frameIndex = Number(slider.value);
      renderCurrent();
      updateWarning();
    });
    $('playBtn').addEventListener('click', togglePlay);
    $('exportBtn').addEventListener('click', exportAndVerify);
    bindCanvasPointer();
  }

  let recomputeTimer: number | undefined;
  function scheduleRecompute(): void {
    clearTimeout(recomputeTimer);
    recomputeTimer = window.setTimeout(recompute, 60);
  }

  function togglePlay(): void {
    playing = !playing;
    $('playBtn').textContent = playing ? '暂停' : '播放';
    if (playing) {
      playTimer = window.setInterval(() => {
        frameIndex = (frameIndex + 1) % FRAME_COUNT;
        slider.value = String(frameIndex);
        renderCurrent();
        updateWarning();
      }, 1000 / FPS);
    } else {
      clearInterval(playTimer);
    }
  }

  function canvasPoint(e: PointerEvent): { x: number; y: number } {
    const cv = $<HTMLCanvasElement>('cvOriginal');
    const rect = cv.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * width,
      y: ((e.clientY - rect.top) / rect.height) * height
    };
  }

  function bindCanvasPointer(): void {
    const cv = $<HTMLCanvasElement>('cvOriginal');
    let dragging = false;
    cv.addEventListener('pointerdown', (e) => {
      const p = canvasPoint(e);
      if (mode === 'sample') {
        dragging = true;
        sampleRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      } else if (mode === 'protect') {
        dragging = true;
        paintProtection(protect, width, height, p.x, p.y, 10);
        scheduleRecompute();
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = canvasPoint(e);
      if (mode === 'sample' && sampleRect) {
        sampleRect.x1 = p.x;
        sampleRect.y1 = p.y;
        renderCurrent();
      } else if (mode === 'protect') {
        paintProtection(protect, width, height, p.x, p.y, 10);
        scheduleRecompute();
      }
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (mode === 'sample' && sampleRect) {
        params.keyColor = sampleBackground(
          frames[frameIndex],
          sampleRect.x0,
          sampleRect.y0,
          sampleRect.x1,
          sampleRect.y1
        );
        syncControls();
        recompute();
      }
    });
  }

  async function exportAndVerify(): Promise<void> {
    const status = $('exportStatus');
    const strip = $('decodeStrip');
    strip.innerHTML = '';
    if (!isWebCodecsSupported()) {
      status.className = 'status err';
      status.textContent = '当前浏览器不支持 WebCodecs，无法导出。';
      return;
    }
    status.className = 'status';
    status.textContent = '编码中…';
    try {
      const encoded = await encodeVideo(composited, {
        width,
        height,
        fps: FPS,
        allKeyFrames: true,
        onProgress: (i, total) => {
          status.textContent = `编码中 ${i}/${total}`;
        }
      });
      status.textContent = `编码完成（${encoded.codec}，${(encoded.bytes.length / 1024).toFixed(1)} KB），解码抽查中…`;
      const decoded = await decodeChunks(encoded);
      const sampleIdx = [0, Math.floor(decoded.length / 2), decoded.length - 1];
      const lines: string[] = [];
      for (const idx of sampleIdx) {
        const d = decoded[idx];
        if (d.width !== width || d.height !== height) {
          throw new Error(`解码尺寸 ${d.width}x${d.height} 与源 ${width}x${height} 不一致`);
        }
        const err = measureDecodeError(
          composited[idx],
          d.rgba,
          frames[idx].truthAlpha,
          d.width,
          d.height
        );
        lines.push(`帧${idx + 1}: 整体MAE ${err.rgbMAE.toFixed(2)} / 边缘MAE ${err.edgeMAE.toFixed(2)}`);
        const figure = document.createElement('figure');
        const c = document.createElement('canvas');
        c.width = d.width;
        c.height = d.height;
        c
          .getContext('2d')!
          .putImageData(
            new ImageData(d.rgba as Uint8ClampedArray<ArrayBuffer>, d.width, d.height),
            0,
            0
          );
        figure.append(c);
        const cap = document.createElement('figcaption');
        cap.textContent = `解码帧 ${idx + 1}`;
        figure.append(cap);
        strip.append(figure);
        d.frame.close();
      }
      const blob = new Blob([encoded.bytes.slice().buffer], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'greenscreen-composite.webm';
      link.textContent = '下载 WebM';
      status.className = 'status ok';
      status.innerHTML = '';
      status.append(`${lines.join('；')}　`, link);
    } catch (err) {
      status.className = 'status err';
      status.textContent = `导出失败：${(err as Error).message}`;
    }
  }
}
