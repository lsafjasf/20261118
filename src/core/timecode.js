/**
 * 时间码与帧率工具。
 * 支持 23.976 / 24 / 25 / 29.97 / 30 等常见帧率。
 * 帧运算统一使用“标称整数帧率”（23.976 -> 24，29.97 -> 30），
 * 29.97 使用丢帧（drop-frame）计数规则。
 */

const NOMINAL_RATES = {
  23.976: 24,
  24: 24,
  25: 25,
  29.97: 30,
  30: 30,
  48: 48,
  50: 50,
  60: 60,
};

export function nominalRate(fps) {
  if (fps == null || Number.isNaN(Number(fps))) {
    throw new Error(`无效帧率: ${fps}`);
  }
  const key = Number(fps);
  if (NOMINAL_RATES[key]) return NOMINAL_RATES[key];
  if (Number.isInteger(key)) return key;
  return Math.round(key);
}

export function isDropFrame(fps) {
  const key = Number(fps);
  return key === 29.97;
}

/** 时间码字符串转绝对帧号 */
export function tcToFrames(tc, fps) {
  if (tc == null) return 0;
  const clean = String(tc).trim().replace(';', ':');
  const parts = clean.split(':').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error(`非法时间码: ${tc}`);
  }
  const [hh, mm, ss, ff] = parts;
  const nominal = nominalRate(fps);
  const drop = isDropFrame(fps);
  let frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (drop) {
    const dropped = Math.round(nominal * 0.066666); // 每整分钟跳过的帧数
    frames -= dropped * (mm - Math.floor(mm / 10));
  }
  return frames;
}

/** 绝对帧号转时间码字符串（丢帧帧率使用分号分隔） */
export function framesToTC(frames, fps) {
  const nominal = nominalRate(fps);
  const drop = isDropFrame(fps);
  const dropped = drop ? Math.round(nominal * 0.066666) : 0;
  let remaining = Math.max(0, Math.round(frames));

  if (drop) {
    const framesPer10Min = nominal * 60 * 10 - dropped * 9;
    const cycles = Math.floor(remaining / framesPer10Min);
    let rest = remaining % framesPer10Min;
    if (rest > dropped) rest += dropped * Math.floor(rest / (nominal * 60 - dropped));
    remaining = cycles * framesPer10Min + rest;
  }

  const ff = remaining % nominal;
  const ss = Math.floor(remaining / nominal) % 60;
  const mm = Math.floor(remaining / (nominal * 60)) % 60;
  const hh = Math.floor(remaining / (nominal * 3600));
  const sep = drop ? ';' : ':';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/** 帧数 -> 秒（使用真实帧率，保证时长换算准确） */
export function framesToSeconds(frames, fps) {
  return Math.round(frames) / Number(fps);
}

/** 秒 -> 帧数（使用真实帧率） */
export function secondsToFrames(seconds, fps) {
  return Math.round(Number(seconds) * Number(fps));
}

/** 毫秒形式的音频偏移 -> 帧（四舍五入到最近帧） */
export function msToFrames(ms, fps) {
  return Math.round((Number(ms) / 1000) * Number(fps));
}

export function formatMs(ms) {
  const value = Number(ms) || 0;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value} ms`;
}
