/* 无头数值验证：统计提取、匹配收敛、高光保护 */
"use strict";
const fs = require("fs");
const path = require("path");

class ImageData {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}
global.ImageData = ImageData;

const root = path.join(__dirname, "..");
const colorSrc = fs.readFileSync(path.join(root, "color.js"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8")
  .split("/* ---------- 预览与刷新 ---------- */")[0];
const {
  analyze, computeMatch, applyAdjustment, evalAdjusted,
  deltaE76, softShoulder, srgbToLinear, linearToSrgb,
} = eval(colorSrc + "\n" + appSrc + `
;({ analyze, computeMatch, applyAdjustment, evalAdjusted, deltaE76, softShoulder, srgbToLinear, linearToSrgb });`);

function makeImage(pixelsFn, w = 120, h = 90) {
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = pixelsFn(x, y, w, h);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  return img;
}

/* 合成场景：中性灰阶 + 肤色块 + 高亮区 */
function scene(x, y, w, h) {
  if (y < h * 0.4) {
    const v = Math.round(60 + 140 * (x / w));
    return [v, v, v];
  }
  if (y < h * 0.7) return [210, 150, 110]; // 肤色
  return [250, 248, 245];                  // 近高光
}

function cast(img, gr, gg, gb, ev) {
  const out = new ImageData(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = srgbToLinear(img.data[i] / 255) * gr * ev;
    const g = srgbToLinear(img.data[i + 1] / 255) * gg * ev;
    const b = srgbToLinear(img.data[i + 2] / 255) * gb * ev;
    out.data[i]     = Math.round(255 * Math.min(1, linearToSrgb(r)));
    out.data[i + 1] = Math.round(255 * Math.min(1, linearToSrgb(g)));
    out.data[i + 2] = Math.round(255 * Math.min(1, linearToSrgb(b)));
    out.data[i + 3] = 255;
  }
  return out;
}

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
}

const base = makeImage(scene);
const warm = cast(base, 1.30, 1.02, 0.70, 1.0);
const cool = cast(base, 0.80, 0.98, 1.28, 0.85);

const sWarm = analyze(warm);
const sCool = analyze(cool);

check("暖镜头色温低于冷镜头", sWarm.cct < sCool.cct,
  `warm=${sWarm.cct}K cool=${sCool.cct}K`);
check("肤色区域被检出", sWarm.skinCount > 500, `count=${sWarm.skinCount}`);
check("中性区域被检出", sWarm.neutralCount > 500, `count=${sWarm.neutralCount}`);

const match = computeMatch(sWarm, sCool, true);
const beforeSkin = deltaE76(sWarm.skinLab, sCool.skinLab);
const after = evalAdjusted(sWarm, match.gains, match.ev, 0, 0);
const afterSkin = deltaE76(after.skinLab, sCool.skinLab);
check("肤色 ΔE 显著下降", afterSkin < beforeSkin * 0.5,
  `before=${beforeSkin.toFixed(2)} after=${afterSkin.toFixed(2)}`);

const beforeNeu = deltaE76(sWarm.neutralLab, sCool.neutralLab);
const afterNeu = deltaE76(after.neutralLab, sCool.neutralLab);
check("中性区 ΔE 显著下降", afterNeu < beforeNeu * 0.5,
  `before=${beforeNeu.toFixed(2)} after=${afterNeu.toFixed(2)}`);

check("中位数亮度向参照收敛",
  Math.abs(after.medianLum - sCool.medianLum) < Math.abs(sWarm.medianLum - sCool.medianLum),
  `src=${sWarm.medianLum.toFixed(4)} adj=${after.medianLum.toFixed(4)} ref=${sCool.medianLum.toFixed(4)}`);

check("软肩不硬裁剪且单调有界",
  softShoulder(0.5) === 0.5 && softShoulder(2) <= 1 && softShoulder(1.2) > softShoulder(0.9),
  `s(2)=${softShoulder(2).toFixed(4)}`);

const adjusted = applyAdjustment(warm, match.gains, match.ev, 0, 0);
let clipped = 0;
for (let i = 0; i < adjusted.data.length; i += 4) {
  if (adjusted.data[i] === 255 && adjusted.data[i + 1] === 255 && adjusted.data[i + 2] === 255) clipped++;
}
check("导出像素无大面积三通道同时截断", clipped / (adjusted.data.length / 4) < 0.02,
  `clipped=${(100 * clipped / (adjusted.data.length / 4)).toFixed(2)}%`);

process.exit(failures ? 1 : 0);
