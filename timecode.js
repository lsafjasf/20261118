(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.TimecodeMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NTSC_RATES = [
    { nominal: 24, actual: 24000 / 1001, aliases: [23.976, 23.98] },
    { nominal: 30, actual: 30000 / 1001, aliases: [29.97, 29.98] },
    { nominal: 60, actual: 60000 / 1001, aliases: [59.94] }
  ];

  const DROP_FRAMES = { 30: 2, 60: 4 };
  const FRAME_EPSILON = 1e-7;

  function normalizeRate(rate) {
    const value = typeof rate === "string" ? Number.parseFloat(rate) : Number(rate);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("帧率必须是大于 0 的数字");
    }

    const ntsc = NTSC_RATES.find((item) =>
      item.aliases.some((alias) => Math.abs(value - alias) < 0.005)
    );
    if (ntsc) {
      return {
        input: value,
        nominal: ntsc.nominal,
        actual: ntsc.actual,
        ntsc: true
      };
    }

    const nominal = Math.round(value);
    if (Math.abs(value - nominal) > 0.0001) {
      return { input: value, nominal, actual: value, ntsc: false };
    }
    return { input: value, nominal, actual: value, ntsc: false };
  }

  function describeRate(rate) {
    const normalized = normalizeRate(rate);
    return normalized.ntsc
      ? `${(normalized.actual).toFixed(3)} fps`
      : `${normalized.actual.toFixed(3)} fps`;
  }

  function supportsDropFrame(rate) {
    const normalized = normalizeRate(rate);
    return normalized.ntsc && Boolean(DROP_FRAMES[normalized.nominal]);
  }

  function validateDomain(domain) {
    if (!domain || typeof domain !== "object") {
      throw new Error("缺少时间码域配置");
    }
    const normalized = normalizeRate(domain.rate);
    if (domain.dropFrame && !supportsDropFrame(normalized.actual)) {
      throw new Error("丢帧时间码仅适用于 29.97 或 59.94 fps");
    }
    return {
      rate: normalized,
      dropFrame: Boolean(domain.dropFrame)
    };
  }

  function parseFields(value) {
    let text = String(value == null ? "" : value).trim();
    if (!text) {
      throw new Error("时间码不能为空");
    }

    let negative = false;
    if (text.startsWith("-")) {
      negative = true;
      text = text.slice(1).trim();
    }

    const match = text.match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[:;.,])(\d{1,3})$/);
    if (!match) {
      throw new Error("格式应为 HH:MM:SS:FF 或 HH:MM:SS;FF");
    }

    return {
      negative,
      hours: Number(match[1]),
      minutes: Number(match[2]),
      seconds: Number(match[3]),
      frames: Number(match[4])
    };
  }

  function timecodeToFrames(value, domain) {
    const config = validateDomain(domain);
    const fields = parseFields(value);
    const { hours, minutes, seconds, frames, negative } = fields;

    if (minutes >= 60 || seconds >= 60) {
      throw new Error("分和秒必须小于 60");
    }
    if (frames >= config.rate.nominal) {
      throw new Error(`帧号必须小于 ${config.rate.nominal}`);
    }

    const dropFrames = DROP_FRAMES[config.rate.nominal] || 0;
    if (config.dropFrame) {
      const totalMinutes = hours * 60 + minutes;
      if (minutes % 10 !== 0 && seconds === 0 && frames < dropFrames) {
        throw new Error("该帧号在丢帧时间码中不存在");
      }
      const droppedLabels = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
      const nominalFrames =
        ((hours * 3600 + minutes * 60 + seconds) * config.rate.nominal) + frames;
      const result = nominalFrames - droppedLabels;
      return negative ? -result : result;
    }

    const nominalFrames =
      ((hours * 3600 + minutes * 60 + seconds) * config.rate.nominal) + frames;
    return negative ? -nominalFrames : nominalFrames;
  }

  function modulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function framesToTimecode(frameNumber, domain, options) {
    const config = validateDomain(domain);
    const opts = options || {};
    const rounded = opts.round === false ? frameNumber : Math.round(frameNumber);
    if (!Number.isFinite(rounded)) {
      throw new Error("帧号不是有效数字");
    }

    const negative = rounded < 0;
    let working = Math.abs(rounded);
    const nominal = config.rate.nominal;
    const dropFrames = DROP_FRAMES[nominal] || 0;
    let displayFrames = working;
    let dayFrames;

    if (config.dropFrame) {
      const framesPerTenMinutes = (nominal * 60 * 10) - (dropFrames * 9);
      const framesPerMinute = (nominal * 60) - dropFrames;
      dayFrames = ((nominal * 60 * 60) - (dropFrames * 54)) * 24;
      working = modulo(working, dayFrames);
      const tenMinuteBlocks = Math.floor(working / framesPerTenMinutes);
      const remainder = working % framesPerTenMinutes;
      const minuteWithinBlock =
        remainder < dropFrames
          ? 0
          : Math.floor((remainder - dropFrames) / framesPerMinute);
      displayFrames =
        working + (dropFrames * 9 * tenMinuteBlocks) + (dropFrames * minuteWithinBlock);
    } else {
      dayFrames = nominal * 60 * 60 * 24;
      working = modulo(working, dayFrames);
      displayFrames = working;
    }

    const frames = displayFrames % nominal;
    const seconds = Math.floor(displayFrames / nominal) % 60;
    const minutes = Math.floor(displayFrames / (nominal * 60)) % 60;
    const hours = Math.floor(displayFrames / (nominal * 3600)) % 24;
    const separator = config.dropFrame ? ";" : ":";
    const label = [hours, minutes, seconds, frames]
      .map((part) => String(part).padStart(2, "0"))
      .join(":")
      .replace(/:(\d{2})$/, `${separator}$1`);
    return `${negative ? "-" : ""}${label}`;
  }

  function framesToSeconds(frameNumber, rate) {
    const normalized = normalizeRate(rate);
    return frameNumber / normalized.actual;
  }

  function secondsToFrames(seconds, rate) {
    const normalized = normalizeRate(rate);
    if (!Number.isFinite(seconds)) {
      throw new Error("秒数不是有效数字");
    }
    return seconds * normalized.actual;
  }

  function timecodeToSeconds(value, domain) {
    const config = validateDomain(domain);
    return framesToSeconds(timecodeToFrames(value, domain), config.rate.actual);
  }

  function secondsToTimecode(seconds, domain) {
    const config = validateDomain(domain);
    return framesToTimecode(secondsToFrames(seconds, config.rate.actual), domain);
  }

  function formatSeconds(seconds, decimals) {
    if (!Number.isFinite(seconds)) {
      return "—";
    }
    const places = decimals == null ? 6 : decimals;
    return `${seconds >= 0 ? "+" : ""}${seconds.toFixed(places)} s`;
  }

  function formatPpm(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)} ppm`;
  }

  function formatsMatch(left, right, domain) {
    try {
      return Math.abs(timecodeToFrames(left, domain) - timecodeToFrames(right, domain)) < FRAME_EPSILON;
    } catch (error) {
      return false;
    }
  }

  return {
    normalizeRate,
    describeRate,
    supportsDropFrame,
    validateDomain,
    timecodeToFrames,
    framesToTimecode,
    framesToSeconds,
    secondsToFrames,
    timecodeToSeconds,
    secondsToTimecode,
    formatSeconds,
    formatPpm,
    formatsMatch,
    FRAME_MODE: {
      DROP: "drop",
      NON_DROP: "non-drop"
    }
  };
});
