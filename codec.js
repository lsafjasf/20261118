/* WebCodecs AV1 编码 / 解码 / 分区质量指标。
 * 所有流共用：30fps、BT.709 limited range、同一确定性场景。
 */
(function (global) {
  const CODEC = "av01.0.08M.08"; // AV1 Main, level 4.0, 8-bit
  const COLOR_SPACE = {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    fullRange: false, // 有限范围（limited / MPEG range）
  };

  function baseConfig(latencyMode) {
    return {
      codec: CODEC,
      width: Scene.W,
      height: Scene.H,
      framerate: Scene.FPS,
      bitrateMode: "quantizer",
      latencyMode, // "quality" = 离线质量档, "realtime" = 实时档
    };
  }

  async function checkSupport() {
    if (!("VideoEncoder" in window) || !("VideoDecoder" in window)) {
      return { ok: false, reason: "当前浏览器不支持 WebCodecs。" };
    }
    for (const mode of ["quality", "realtime"]) {
      try {
        const res = await VideoEncoder.isConfigSupported(baseConfig(mode));
        if (!res.supported) {
          return { ok: false, reason: `AV1 量化模式（${mode}）不受支持，请使用较新的 Chrome/Edge。` };
        }
      } catch (e) {
        return { ok: false, reason: "配置探测失败：" + e.message };
      }
    }
    return { ok: true };
  }

  function makeVideoFrame(canvas, index) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = ctx.getImageData(0, 0, Scene.W, Scene.H).data;
    const i420 = rgbaToI420Bt709Limited(rgba, Scene.W, Scene.H);
    return new VideoFrame(i420, {
      format: "I420",
      codedWidth: Scene.W,
      codedHeight: Scene.H,
      timestamp: Math.round((index * 1e6) / Scene.FPS),
      duration: Math.round(1e6 / Scene.FPS),
      colorSpace: COLOR_SPACE, // 明确指定 BT.709 有限范围
    });
  }

  // RGBA → I420，BT.709 系数、studio/limited range（Y:16-235，UV:16-240）
  function rgbaToI420Bt709Limited(rgba, w, h) {
    const ySize = w * h;
    const uvW = w >> 1, uvH = h >> 1;
    const out = new Uint8Array(ySize + 2 * uvW * uvH);
    const uPlane = ySize, vPlane = ySize + uvW * uvH;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        out[y * w + x] = 16.5 + 0.18259 * r + 0.61412 * g + 0.06201 * b;
      }
    }
    for (let y = 0; y < uvH; y++) {
      for (let x = 0; x < uvW; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const o = ((y * 2 + dy) * w + x * 2 + dx) * 4;
            r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2];
          }
        }
        r >>= 2; g >>= 2; b >>= 2;
        const p = y * uvW + x;
        out[uPlane + p] = 128.5 - 0.09840 * r - 0.33101 * g + 0.42940 * b;
        out[vPlane + p] = 128.5 + 0.42940 * r - 0.39004 * g - 0.03937 * b;
      }
    }
    return out;
  }

  // 编码整段场景，返回裸码流与耗时
  async function encodeStream(cfg, srcCanvas, onProgress) {
    const chunks = [];
    let sizeBytes = 0;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        sizeBytes += chunk.byteLength;
        chunks.push({ data: buf, type: chunk.type, timestamp: chunk.timestamp });
      },
      error: (e) => { throw e; },
    });
    encoder.configure(baseConfig(cfg.latencyMode));

    const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
    const t0 = performance.now();
    for (let i = 0; i < Scene.FRAMES; i++) {
      Scene.renderFrame(ctx, i);
      const frame = makeVideoFrame(srcCanvas, i);
      encoder.encode(frame, {
        keyFrame: i % cfg.gop === 0,
        av1: { quantizer: cfg.qp },
      });
      frame.close();
      if (encoder.encodeQueueSize > 8) {
        await new Promise((r) => { encoder.addEventListener("dequeue", r, { once: true }); });
      }
      if (onProgress) onProgress((i + 1) / Scene.FRAMES);
    }
    await encoder.flush();
    const encodeMs = performance.now() - t0;
    encoder.close();
    return { chunks, sizeBytes, encodeMs };
  }

  // 解码整段码流；onFrame(frame, index) 中必须自行 close 或交由调用方处理
  async function decodeStream(chunks, onFrame) {
    let index = 0;
    let colorSpace = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!colorSpace && frame.colorSpace) {
          const cs = frame.colorSpace;
          colorSpace = `${cs.primaries || "?"} / ${cs.fullRange ? "full" : "limited"}`;
        }
        onFrame(frame, index++);
      },
      error: (e) => { throw e; },
    });
    decoder.configure({ codec: CODEC });
    for (const c of chunks) {
      decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, data: c.data }));
      if (decoder.decodeQueueSize > 8) {
        await new Promise((r) => { decoder.addEventListener("dequeue", r, { once: true }); });
      }
    }
    await decoder.flush();
    decoder.close();
    return { colorSpace, frameCount: index };
  }

  // 分区 PSNR 累加器：对源画面与解码画面在三个区域内累计平方误差
  function createMetricsAccumulator() {
    const acc = { overall: { sse: 0, n: 0 }, flat: { sse: 0, n: 0 }, motion: { sse: 0, n: 0 }, highfreq: { sse: 0, n: 0 } };
    const tmp = document.createElement("canvas");
    tmp.width = Scene.W; tmp.height = Scene.H;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });

    function accumulateRect(name, srcData, decData, rect) {
      const a = acc[name];
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const o = (y * Scene.W + x) * 4;
          for (let c = 0; c < 3; c++) {
            const d = srcData[o + c] - decData[o + c];
            a.sse += d * d;
          }
          a.n += 3;
        }
      }
    }

    return {
      add(srcCanvas, decCanvas, frameIndex) {
        tctx.drawImage(decCanvas, 0, 0);
        const dec = tctx.getImageData(0, 0, Scene.W, Scene.H).data;
        const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
        const src = sctx.getImageData(0, 0, Scene.W, Scene.H).data;
        const full = { x: 0, y: 0, w: Scene.W, h: Scene.H };
        accumulateRect("overall", src, dec, full);
        const regions = Scene.getRegions(frameIndex);
        accumulateRect("flat", src, dec, regions.flat);
        accumulateRect("motion", src, dec, regions.motion);
        accumulateRect("highfreq", src, dec, regions.highfreq);
      },
      psnr(name) {
        const a = acc[name];
        if (!a.n || a.sse === 0) return Infinity;
        return 10 * Math.log10((255 * 255 * a.n) / a.sse);
      },
    };
  }

  global.Codec = { CODEC, COLOR_SPACE, checkSupport, encodeStream, decodeStream, createMetricsAccumulator };
})(window);
