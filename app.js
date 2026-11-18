/* 主逻辑：统计提取、匹配计算、预览渲染、导出 */
"use strict";

const state = {
  imgA: null, imgB: null,       // {data: ImageData, canvas}
  statsA: null, statsB: null,
  match: null,                  // 自动匹配结果
};

const $ = (id) => document.getElementById(id);

/* ---------- 图像载入 ---------- */

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function imageToData(img, maxW = 800) {
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), canvas: cv };
}

/* ---------- 统计量提取 ---------- */

/* 中性区域检测：取中间调像素对数通道比 (log2 R/G, log2 B/G) 的中位数作为
   画面主色偏方向，再收集中位数附近的像素作为中性集合。
   中位数可容忍近半数污染（肤色、饱和色块），且对 8bit 量化散射稳健 */
function detectNeutral(mid) {
  const n = mid.length / 3;
  if (n < 32) return null;
  const us = new Float32Array(n), vs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.max(mid[i * 3], 1e-3), g = Math.max(mid[i * 3 + 1], 1e-3),
          b = Math.max(mid[i * 3 + 2], 1e-3);
    us[i] = Math.log2(r / g);
    vs[i] = Math.log2(b / g);
  }
  const mu = median(us), mv = median(vs);
  const TOL = 0.1;
  let sr = 0, sg = 0, sb = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(us[i] - mu) > TOL || Math.abs(vs[i] - mv) > TOL) continue;
    sr += mid[i * 3]; sg += mid[i * 3 + 1]; sb += mid[i * 3 + 2];
    count++;
  }
  if (count < 32) return null;
  return { mean: { r: sr / count, g: sg / count, b: sb / count }, count };
}

function analyze(imageData) {
  const d = imageData.data;
  const lums = [];
  const mid = [];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const rn = r / 255, gn = g / 255, bn = b / 255;
    lums.push(relLuminance(rn, gn, bn));
    if (isMidtone(r, g, b)) mid.push(rn, gn, bn);
  }
  const neu = detectNeutral(mid);
  /* 第二遍：先用中性区估计的预白平衡校正像素，再做肤色判定 */
  const wb = neu ? {
    r: srgbToLinear(neu.mean.g) / Math.max(srgbToLinear(neu.mean.r), 1e-4),
    g: 1,
    b: srgbToLinear(neu.mean.g) / Math.max(srgbToLinear(neu.mean.b), 1e-4),
  } : { r: 1, g: 1, b: 1 };
  let skinCount = 0, skinR = 0, skinG = 0, skinB = 0;
  for (let i = 0; i < d.length; i += 4) {
    const rl = srgbToLinear(d[i] / 255) * wb.r;
    const gl = srgbToLinear(d[i + 1] / 255) * wb.g;
    const bl = srgbToLinear(d[i + 2] / 255) * wb.b;
    const rc = Math.round(255 * Math.min(1, linearToSrgb(rl)));
    const gc = Math.round(255 * Math.min(1, linearToSrgb(gl)));
    const bc = Math.round(255 * Math.min(1, linearToSrgb(bl)));
    if (isSkin(rc, gc, bc)) {
      skinCount++;
      skinR += d[i] / 255; skinG += d[i + 1] / 255; skinB += d[i + 2] / 255;
    }
  }
  const skin = skinCount
    ? { r: skinR / skinCount, g: skinG / skinCount, b: skinB / skinCount }
    : null;
  return {
    skinCount,
    skin,
    skinLab: skin ? rgbToLab(skin.r, skin.g, skin.b) : null,
    neutralCount: neu ? neu.count : 0,
    neutral: neu ? neu.mean : null,
    neutralLab: neu ? rgbToLab(neu.mean.r, neu.mean.g, neu.mean.b) : null,
    cct: neu ? rgbToCct(neu.mean.r, neu.mean.g, neu.mean.b) : null,
    medianLum: median(lums),
  };
}

/* ---------- 匹配计算 ---------- */

function applyGainsToRgb(rgb, gains) {
  return {
    r: rgb.r * gains.r,
    g: rgb.g * gains.g,
    b: rgb.b * gains.b,
  };
}

/* 中性区域灰世界白平衡 + 可选肤色锁定迭代修正 */
function computeMatch(src, ref, lockSkin) {
  let gains = { r: 1, g: 1, b: 1 };
  if (src.neutral && ref.neutral) {
    const sn = { r: srgbToLinear(src.neutral.r), g: srgbToLinear(src.neutral.g), b: srgbToLinear(src.neutral.b) };
    const rn = { r: srgbToLinear(ref.neutral.r), g: srgbToLinear(ref.neutral.g), b: srgbToLinear(ref.neutral.b) };
    gains = {
      r: rn.r / Math.max(sn.r, 1e-4),
      g: rn.g / Math.max(sn.g, 1e-4),
      b: rn.b / Math.max(sn.b, 1e-4),
    };
    const norm = gains.g;
    gains = { r: gains.r / norm, g: 1, b: gains.b / norm };
  }
  if (lockSkin && src.skinLab && ref.skinLab) {
    const skinLin = { r: srgbToLinear(src.skin.r), g: srgbToLinear(src.skin.g), b: srgbToLinear(src.skin.b) };
    for (let it = 0; it < 5; it++) {
      const adj = applyGainsToRgb(skinLin, gains);
      const lab = rgbToLab(linearToSrgb(adj.r), linearToSrgb(adj.g), linearToSrgb(adj.b));
      const da = ref.skinLab.a - lab.a;
      const db = ref.skinLab.b - lab.b;
      if (Math.abs(da) < 0.05 && Math.abs(db) < 0.05) break;
      gains.r *= 1 + da * 0.004;
      gains.b *= 1 - db * 0.004;
      gains.g *= 1 - da * 0.001;
    }
  }
  const ev = Math.max(0.25, Math.min(4, ref.medianLum / Math.max(src.medianLum, 1e-4)));
  return { gains, ev };
}

/* ---------- 调整应用与高光保护 ---------- */

function applyAdjustment(imageData, gains, ev, temp, tint) {
  const out = new ImageData(imageData.width, imageData.height);
  const src = imageData.data, dst = out.data;
  const tt = tempTintToGains(temp, tint);
  const gr = gains.r * tt.r * ev;
  const gg = gains.g * tt.g * tt.gm * ev;
  const gb = gains.b * tt.b * ev;
  for (let i = 0; i < src.length; i += 4) {
    const rl = srgbToLinear(src[i] / 255) * gr;
    const gl = srgbToLinear(src[i + 1] / 255) * gg;
    const bl = srgbToLinear(src[i + 2] / 255) * gb;
    dst[i]     = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(softShoulder(rl)))));
    dst[i + 1] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(softShoulder(gl)))));
    dst[i + 2] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(softShoulder(bl)))));
    dst[i + 3] = src[i + 3];
  }
  return out;
}

/* ---------- 统计表与报告渲染 ---------- */

function fmt(x, digits = 3) {
  return x === null || x === undefined ? "—" : Number(x).toFixed(digits);
}

function renderStats() {
  const tb = document.querySelector("#statsTable tbody");
  const a = state.statsA, b = state.statsB;
  if (!a || !b) { tb.innerHTML = ""; return; }
  const rows = [
    ["肤色像素数", a.skinCount, b.skinCount, 0],
    ["肤色 L*", a.skinLab && a.skinLab.L, b.skinLab && b.skinLab.L, 1],
    ["肤色 a*", a.skinLab && a.skinLab.a, b.skinLab && b.skinLab.a, 1],
    ["肤色 b*", a.skinLab && a.skinLab.b, b.skinLab && b.skinLab.b, 1],
    ["中性区像素数", a.neutralCount, b.neutralCount, 0],
    ["中性区 R", a.neutral && a.neutral.r, b.neutral && b.neutral.r, 3],
    ["中性区 G", a.neutral && a.neutral.g, b.neutral && b.neutral.g, 3],
    ["中性区 B", a.neutral && a.neutral.b, b.neutral && b.neutral.b, 3],
    ["估计色温 (K)", a.cct, b.cct, 0],
    ["中位数亮度", a.medianLum, b.medianLum, 4],
  ];
  tb.innerHTML = rows
    .map(([k, va, vb, d]) => `<tr><td>${k}</td><td>${fmt(va, d)}</td><td>${fmt(vb, d)}</td></tr>`)
    .join("");
}

function currentDirection() {
  return $("refDir").value === "AtoB"
    ? { src: "A", ref: "B", srcImg: state.imgA, refImg: state.imgB,
        srcStats: state.statsA, refStats: state.statsB }
    : { src: "B", ref: "A", srcImg: state.imgB, refImg: state.imgA,
        srcStats: state.statsB, refStats: state.statsA };
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function renderReport(before, after) {
  const { srcStats, refStats } = currentDirection();
  const tb = document.querySelector("#reportTable tbody");
  const skinBefore = srcStats.skinLab && refStats.skinLab
    ? deltaE76(before.skinLab, refStats.skinLab) : null;
  const skinAfter = after.skinLab && refStats.skinLab
    ? deltaE76(after.skinLab, refStats.skinLab) : null;
  const neuBefore = before.neutralLab && refStats.neutralLab
    ? deltaE76(before.neutralLab, refStats.neutralLab) : null;
  const neuAfter = after.neutralLab && refStats.neutralLab
    ? deltaE76(after.neutralLab, refStats.neutralLab) : null;
  const rows = [
    ["肤色 ΔE76（对参照）", fmt(skinBefore, 2), fmt(skinAfter, 2)],
    ["中性区 ΔE76（对参照）", fmt(neuBefore, 2), fmt(neuAfter, 2)],
    ["中位数亮度（源）", fmt(before.medianLum, 4), fmt(after.medianLum, 4)],
    ["中位数亮度（参照）", fmt(refStats.medianLum, 4), fmt(refStats.medianLum, 4)],
  ];
  tb.innerHTML = rows
    .map(([k, v1, v2]) => `<tr><td>${k}</td><td>${v1}</td><td>${v2}</td></tr>`)
    .join("");
}

/* 对统计点施加当前增益，得到调整后的肤色/中性 Lab 与亮度 */
function evalAdjusted(srcStats, gains, ev, temp, tint) {
  const tt = tempTintToGains(temp, tint);
  const g = {
    r: gains.r * tt.r * ev,
    g: gains.g * tt.g * tt.gm * ev,
    b: gains.b * tt.b * ev,
  };
  const applyPt = (p) => p && {
    r: Math.min(1, srgbToLinear(p.r) * g.r),
    g: Math.min(1, srgbToLinear(p.g) * g.g),
    b: Math.min(1, srgbToLinear(p.b) * g.b),
  };
  const toLab = (p) => p && rgbToLab(
    linearToSrgb(softShoulder(p.r)),
    linearToSrgb(softShoulder(p.g)),
    linearToSrgb(softShoulder(p.b))
  );
  const skinLin = applyPt(srcStats.skin);
  const neuLin = applyPt(srcStats.neutral);
  return {
    skinLab: toLab(skinLin),
    neutralLab: toLab(neuLin),
    medianLum: Math.min(1, srcStats.medianLum * ev),
  };
}

/* ---------- 预览与刷新 ---------- */

function getSliders() {
  return {
    temp: Number($("adjTemp").value),
    tint: Number($("adjTint").value),
    exp: Number($("adjExp").value) / 100,
  };
}

function refresh() {
  if (!state.imgA || !state.imgB) return;
  const dir = currentDirection();
  const mode = currentMode();
  const lockSkin = $("lockSkin").checked;
  state.match = computeMatch(dir.srcStats, dir.refStats, lockSkin);

  const s = getSliders();
  let gains = { r: 1, g: 1, b: 1 }, ev = 1, temp = 0, tint = 0;
  if (mode === "auto") {
    gains = state.match.gains; ev = state.match.ev;
  } else if (mode === "manual") {
    gains = state.match.gains; ev = state.match.ev * Math.pow(2, s.exp);
    temp = s.temp; tint = s.tint;
  }

  const pv = $("preview");
  const ctx = pv.getContext("2d");
  pv.width = dir.srcImg.data.width;
  pv.height = dir.srcImg.data.height;
  const out = mode === "original"
    ? dir.srcImg.data
    : applyAdjustment(dir.srcImg.data, gains, ev, temp, tint);
  ctx.putImageData(out, 0, 0);

  const before = {
    skinLab: dir.srcStats.skinLab,
    neutralLab: dir.srcStats.neutralLab,
    medianLum: dir.srcStats.medianLum,
  };
  const after = evalAdjusted(dir.srcStats, gains, ev, temp, tint);
  renderReport(before, after);
}

/* ---------- 导出 ---------- */

function exportPng() {
  if (!state.imgA || !state.imgB) return;
  const dir = currentDirection();
  const mode = currentMode();
  const s = getSliders();
  let gains = { r: 1, g: 1, b: 1 }, ev = 1, temp = 0, tint = 0;
  if (mode !== "original") {
    gains = state.match.gains;
    ev = state.match.ev;
    if (mode === "manual") {
      ev *= Math.pow(2, s.exp);
      temp = s.temp; tint = s.tint;
    }
  }
  const out = applyAdjustment(dir.srcImg.data, gains, ev, temp, tint);
  const cv = document.createElement("canvas");
  cv.width = out.width; cv.height = out.height;
  cv.getContext("2d").putImageData(out, 0, 0);
  const a = document.createElement("a");
  a.download = `matched_${dir.src}_to_${dir.ref}.png`;
  a.href = cv.toDataURL("image/png");
  a.click();
}

/* ---------- 演示镜头生成 ---------- */

function drawScene() {
  const cv = document.createElement("canvas");
  cv.width = 640; cv.height = 360;
  const ctx = cv.getContext("2d");
  const sky = ctx.createLinearGradient(0, 0, 0, 240);
  sky.addColorStop(0, "#aebdc9");
  sky.addColorStop(1, "#d8d4c8");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 640, 240);
  ctx.fillStyle = "#5c6b52";
  ctx.fillRect(0, 240, 640, 120);
  const grays = ["#3a3a3a", "#6e6e6e", "#a8a8a8", "#dcdcdc", "#f8f8f8"];
  grays.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(30 + i * 70, 260, 60, 80);
  });
  const skins = ["#e8b98d", "#c98a5e", "#8a5a3b", "#f0c8a8"];
  skins.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(420 + i * 55, 150, 24, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(560, 60, 28, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, 640, 360);
}

function castImage(imageData, gains, ev) {
  const out = new ImageData(imageData.width, imageData.height);
  const s = imageData.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const rl = srgbToLinear(s[i] / 255) * gains.r * ev;
    const gl = srgbToLinear(s[i + 1] / 255) * gains.g * ev;
    const bl = srgbToLinear(s[i + 2] / 255) * gains.b * ev;
    d[i]     = Math.round(255 * Math.min(1, linearToSrgb(rl)));
    d[i + 1] = Math.round(255 * Math.min(1, linearToSrgb(gl)));
    d[i + 2] = Math.round(255 * Math.min(1, linearToSrgb(bl)));
    d[i + 3] = s[i + 3];
  }
  return out;
}

function makeDemoShots() {
  const scene = drawScene();
  const warm = castImage(scene, { r: 1.28, g: 1.02, b: 0.72 }, 1.0);
  const cool = castImage(scene, { r: 0.78, g: 0.98, b: 1.30 }, 0.85);
  const mk = (data) => {
    const cv = document.createElement("canvas");
    cv.width = data.width; cv.height = data.height;
    cv.getContext("2d").putImageData(data, 0, 0);
    return { data, canvas: cv };
  };
  state.imgA = mk(warm);
  state.imgB = mk(cool);
  afterLoad();
}

/* ---------- 装配与事件 ---------- */

function drawThumb(img, canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img.canvas, 0, 0, canvas.width, canvas.height);
}

function afterLoad() {
  state.statsA = analyze(state.imgA.data);
  state.statsB = analyze(state.imgB.data);
  drawThumb(state.imgA, $("thumbA"));
  drawThumb(state.imgB, $("thumbB"));
  renderStats();
  refresh();
}

async function onFile(which, file) {
  const img = await loadImageFile(file);
  const rec = imageToData(img);
  if (which === "A") state.imgA = rec; else state.imgB = rec;
  if (state.imgA && state.imgB) afterLoad();
}

function bindEvents() {
  $("fileA").addEventListener("change", (e) => e.target.files[0] && onFile("A", e.target.files[0]));
  $("fileB").addEventListener("change", (e) => e.target.files[0] && onFile("B", e.target.files[0]));
  $("btnDemo").addEventListener("click", makeDemoShots);
  $("btnExport").addEventListener("click", exportPng);
  $("btnReset").addEventListener("click", () => {
    $("adjTemp").value = 0; $("adjTint").value = 0; $("adjExp").value = 0;
    syncSliderLabels();
    refresh();
  });
  $("refDir").addEventListener("change", refresh);
  $("lockSkin").addEventListener("change", refresh);
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", refresh));
  ["adjTemp", "adjTint", "adjExp"].forEach((id) =>
    $(id).addEventListener("input", () => {
      syncSliderLabels();
      document.querySelector('input[name="mode"][value="manual"]').checked = true;
      refresh();
    }));
}

function syncSliderLabels() {
  $("valTemp").textContent = $("adjTemp").value;
  $("valTint").textContent = $("adjTint").value;
  $("valExp").textContent = (Number($("adjExp").value) / 100).toFixed(2);
}

bindEvents();
syncSliderLabels();
