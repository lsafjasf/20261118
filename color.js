/* 色彩科学基础：sRGB/线性、XYZ、Lab、色温估计、高光软肩 */
"use strict";

const D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function rgbToXyz(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  return {
    x: 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl,
    y: 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl,
    z: 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl,
  };
}

function xyzToLab(x, y, z) {
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x / D65.x), fy = f(y / D65.y), fz = f(z / D65.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function rgbToLab(r, g, b) {
  const xyz = rgbToXyz(r, g, b);
  return xyzToLab(xyz.x, xyz.y, xyz.z);
}

/* McCamy 公式由 CIE xy 色度估计相关色温 (K) */
function rgbToCct(r, g, b) {
  const xyz = rgbToXyz(r, g, b);
  const sum = xyz.x + xyz.y + xyz.z;
  if (sum <= 1e-9) return null;
  const cx = xyz.x / sum, cy = xyz.y / sum;
  const n = (cx - 0.3320) / (cy - 0.1858);
  const cct = -449 * n ** 3 + 3525 * n ** 2 - 6823.3 * n + 5520.33;
  return Math.round(cct);
}

/* 相对亮度 (Rec.709 luma，线性域) */
function relLuminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/* YCbCr 肤色模型（JPEG 全幅系数），配合亮度范围过滤。
   应在白平衡校正后的像素上判定，避免色偏镜头的中性灰被误判为肤色 */
function isSkin(r8, g8, b8) {
  const y  =  0.299 * r8 + 0.587 * g8 + 0.114 * b8;
  const cb = 128 - 0.168736 * r8 - 0.331264 * g8 + 0.5 * b8;
  const cr = 128 + 0.5 * r8 - 0.418688 * g8 - 0.081312 * b8;
  return y > 40 && y < 235 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/* 中间调候选（迭代中性检测的第一轮输入） */
function isMidtone(r8, g8, b8) {
  const y = 0.299 * r8 + 0.587 * g8 + 0.114 * b8;
  return y >= 50 && y <= 205;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* 高光软肩：0.8 以下线性，以上用 tanh 平滑压缩到 1.0，避免通道硬裁剪 */
function softShoulder(x) {
  const knee = 0.8;
  if (x <= knee) return x;
  return knee + (1 - knee) * Math.tanh((x - knee) / (1 - knee));
}

/* 色温/色调滑杆 → RGB 增益（近似黑体偏移，-100..100） */
function tempTintToGains(temp, tint) {
  const t = temp / 100, u = tint / 100;
  return {
    r: 1 + 0.30 * t,
    g: 1 - 0.15 * u,
    b: 1 - 0.30 * t,
    gm: 1 + 0.15 * u,
  };
}

function deltaE76(lab1, lab2) {
  return Math.sqrt(
    (lab1.L - lab2.L) ** 2 + (lab1.a - lab2.a) ** 2 + (lab1.b - lab2.b) ** 2
  );
}
