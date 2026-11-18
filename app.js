/* 编排：三组参数编码 → 解码分析（分区 PSNR）→ 并排循环播放 + 实时差异图 */
(function () {
  const CONFIGS = [
    { id: "A", name: "A · 细节优先（离线质量档）", latencyMode: "quality", gop: 30, qp: 19 },
    { id: "B", name: "B · 均衡（离线质量档）", latencyMode: "quality", gop: 60, qp: 30 },
    { id: "C", name: "C · 速度优先（实时档）", latencyMode: "realtime", gop: 90, qp: 41 },
  ];
  const SCALE = 0.5;
  const PW = Scene.W * SCALE;
  const PH = Scene.H * SCALE;

  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const btnStart = $("#btn-start");
  const btnPlay = $("#btn-play");
  const ampSel = $("#diff-amp");

  const refCanvas = $("#ref-canvas");
  const refCtx = refCanvas.getContext("2d");
  const overlayCtx = $("#ref-overlay").getContext("2d");

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = Scene.W;
  srcCanvas.height = Scene.H;
  const srcSmall = document.createElement("canvas");
  srcSmall.width = PW;
  srcSmall.height = PH;
  const srcSmallCtx = srcSmall.getContext("2d", { willReadFrequently: true });

  const streams = [];
  let playing = false;
  let rafId = 0;
  let playT0 = 0;
  let lastIdx = -1;

  function setStatus(msg) { statusEl.textContent = msg; }

  function buildPanels() {
    const host = $("#streams");
    const tpl = $("#tpl-stream");
    for (const cfg of CONFIGS) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector(".st-title").textContent = cfg.name;
      node.querySelector(".st-params").textContent =
        `latencyMode=${cfg.latencyMode} · 关键帧间隔 GOP=${cfg.gop} 帧 · 量化参数 QP=${cfg.qp} · 30fps · BT.709 limited`;
      host.appendChild(node);
      streams.push({
        cfg,
        el: {
          play: node.querySelector(".cv-play"),
          diff: node.querySelector(".cv-diff"),
          bar: node.querySelector(".bar"),
          size: node.querySelector(".s-size"),
          time: node.querySelector(".s-time"),
          fps: node.querySelector(".s-fps"),
          psnr: node.querySelector(".s-psnr"),
          flat: node.querySelector(".s-flat"),
          motion: node.querySelector(".s-motion"),
          hf: node.querySelector(".s-hf"),
          color: node.querySelector(".s-color"),
        },
        chunks: null,
        frames: [],
      });
    }
  }

  function fmtPsnr(v) {
    if (!isFinite(v)) return "∞（无损）";
    return v.toFixed(2) + " dB";
  }

  function fmtSize(bytes) {
    return bytes > (1 << 20) ? (bytes / (1 << 20)).toFixed(2) + " MiB" : (bytes / 1024).toFixed(1) + " KiB";
  }

  async function runComparison() {
    btnStart.disabled = true;
    const support = await Codec.checkSupport();
    if (!support.ok) { setStatus(support.reason); return; }

    for (const st of streams) {
      const { cfg, el } = st;
      setStatus(`正在编码 ${cfg.id} 组（${cfg.latencyMode}，GOP=${cfg.gop}，QP=${cfg.qp}）…`);
      const result = await Codec.encodeStream(cfg, srcCanvas, (p) => {
        el.bar.style.width = (p * 50) + "%";
      });
      st.chunks = result.chunks;

      setStatus(`正在解码分析 ${cfg.id} 组…`);
      const metrics = Codec.createMetricsAccumulator();
      const decCanvas = document.createElement("canvas");
      decCanvas.width = Scene.W;
      decCanvas.height = Scene.H;
      const decCtx = decCanvas.getContext("2d");
      const smallCanvas = document.createElement("canvas");
      smallCanvas.width = PW;
      smallCanvas.height = PH;
      const smallCtx = smallCanvas.getContext("2d");
      st.frames = [];

      const info = await Codec.decodeStream(st.chunks, (frame, i) => {
        decCtx.drawImage(frame, 0, 0);
        Scene.renderFrame(srcCanvas.getContext("2d"), i);
        metrics.add(srcCanvas, decCanvas, i);
        smallCtx.drawImage(frame, 0, 0, PW, PH);
        st.frames.push(smallCtx.getImageData(0, 0, PW, PH));
        frame.close();
        el.bar.style.width = (50 + ((i + 1) / Scene.FRAMES) * 50) + "%";
      });

      el.size.textContent = fmtSize(result.sizeBytes);
      el.time.textContent = result.encodeMs.toFixed(0) + " ms";
      el.fps.textContent = (Scene.FRAMES / (result.encodeMs / 1000)).toFixed(1) + " 帧/秒";
      el.psnr.textContent = fmtPsnr(metrics.psnr("overall"));
      el.flat.textContent = fmtPsnr(metrics.psnr("flat"));
      el.motion.textContent = fmtPsnr(metrics.psnr("motion"));
      el.hf.textContent = fmtPsnr(metrics.psnr("highfreq"));
      el.color.textContent = info.colorSpace || "未知";
    }
    setStatus(`完成：共 ${Scene.FRAMES} 帧。点击“播放 / 暂停”并排查看三路解码结果与差异图。`);
    btnPlay.disabled = false;
    startPlayback();
  }

  function drawRegions(ctx, scale) {
    const regions = Scene.getRegions(lastIdx);
    const draw = (r, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x * scale + 0.5, r.y * scale + 0.5, r.w * scale - 1, r.h * scale - 1);
    };
    draw(regions.flat, "#39c98e");
    draw(regions.motion, "#ff9f43");
    draw(regions.highfreq, "#e05fd0");
  }

  function renderDiff(st, srcData) {
    const amp = Number(ampSel.value);
    const dec = st.frames[lastIdx].data;
    const out = st.diffImage.data;
    for (let i = 0; i < dec.length; i += 4) {
      out[i] = Math.min(255, Math.abs(srcData[i] - dec[i]) * amp);
      out[i + 1] = Math.min(255, Math.abs(srcData[i + 1] - dec[i + 1]) * amp);
      out[i + 2] = Math.min(255, Math.abs(srcData[i + 2] - dec[i + 2]) * amp);
      out[i + 3] = 255;
    }
    const dctx = st.el.diff.getContext("2d");
    dctx.putImageData(st.diffImage, 0, 0);
    drawRegions(dctx, SCALE);
  }

  function renderFrame(idx) {
    lastIdx = idx;
    Scene.renderFrame(refCtx, idx);
    overlayCtx.clearRect(0, 0, Scene.W, Scene.H);
    drawRegions(overlayCtx, 1);

    srcSmallCtx.drawImage(refCanvas, 0, 0, PW, PH);
    const srcData = srcSmallCtx.getImageData(0, 0, PW, PH).data;

    for (const st of streams) {
      if (!st.frames.length) continue;
      st.el.play.getContext("2d").putImageData(st.frames[idx], 0, 0);
      renderDiff(st, srcData);
    }
  }

  function tick(now) {
    if (!playing) return;
    const idx = Math.floor(((now - playT0) / 1000) * Scene.FPS) % Scene.FRAMES;
    if (idx !== lastIdx) renderFrame(idx);
    rafId = requestAnimationFrame(tick);
  }

  function startPlayback() {
    if (playing) return;
    for (const st of streams) {
      st.diffImage = st.el.diff.getContext("2d").createImageData(PW, PH);
    }
    playing = true;
    playT0 = performance.now();
    lastIdx = -1;
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    playing = false;
    cancelAnimationFrame(rafId);
  }

  btnPlay.addEventListener("click", () => {
    if (playing) { stopPlayback(); } else { startPlayback(); }
  });
  btnStart.addEventListener("click", () => {
    runComparison().catch((e) => setStatus("出错：" + e.message));
  });

  buildPanels();
  Scene.renderFrame(refCtx, 0);
  lastIdx = 0;
  drawRegions(overlayCtx, 1);
})();
