/* 公共工具：命名空间、阈值预设、时间/文件辅助。浏览器与 Node 测试双环境可用。 */
(function (root) {
  "use strict";

  var VFA = root.VFA || {};
  root.VFA = VFA;

  VFA.PRESETS = {
    loose: {
      label: "宽松",
      luma: 4.0,
      edge: 0.018,
      motion: 0.035,
      lowlight: 32,
      lowlightFactor: 0.55
    },
    standard: {
      label: "标准",
      luma: 2.5,
      edge: 0.01,
      motion: 0.02,
      lowlight: 32,
      lowlightFactor: 0.55
    },
    strict: {
      label: "严格",
      luma: 1.5,
      edge: 0.006,
      motion: 0.012,
      lowlight: 32,
      lowlightFactor: 0.55
    }
  };

  VFA.clone = function (obj) {
    return JSON.parse(JSON.stringify(obj));
  };

  VFA.clamp = function (v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  };

  VFA.round1 = function (v) { return Math.round(v * 10) / 10; };
  VFA.round2 = function (v) { return Math.round(v * 100) / 100; };
  VFA.round3 = function (v) { return Math.round(v * 1000) / 1000; };

  VFA.fmtTime = function (seconds) {
    if (!isFinite(seconds)) return "--:--";
    var s = Math.max(0, seconds);
    var m = Math.floor(s / 60);
    var rem = (s - m * 60).toFixed(1);
    if (rem.length < 4) rem = "0" + rem;
    return (m < 10 ? "0" + m : "" + m) + ":" + rem;
  };

  VFA.mean = function (arr) {
    if (!arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  };

  VFA.csvEscape = function (v) {
    var s = String(v == null ? "" : v);
    if (/[",\n]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  VFA.download = function (filename, content, mime) {
    var blob = content instanceof Blob
      ? content
      : new Blob([content], { type: mime || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };

  VFA.readJSONFile = function (file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try { resolve(JSON.parse(reader.result)); }
        catch (e) { reject(e); }
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  };

  /* 可复现的伪随机数（测试片噪声用）。 */
  VFA.lcg = function (seed) {
    var state = seed >>> 0;
    return function () {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VFA;
  }
})(typeof window !== "undefined" ? window : globalThis);
