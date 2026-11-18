/* UI 冒烟测试：以最小 DOM/Canvas 桩驱动 afterLoad → refresh → 导出全链路 */
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

function makeCtx(canvas) {
  return {
    canvas,
    fillStyle: null,
    getImageData: (x, y, w, h) => {
      const img = canvas._store && canvas._store.width === w && canvas._store.height === h
        ? canvas._store : new ImageData(w, h);
      return img;
    },
    putImageData: (img) => { canvas._store = img; },
    drawImage: (src) => { if (src._store) canvas._store = src._store; },
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {}, clearRect: () => {}, beginPath: () => {},
    arc: () => {}, fill: () => {},
  };
}

function makeCanvas() {
  const c = { width: 300, height: 150, _store: null, _ctx: null };
  c.getContext = () => (c._ctx ||= makeCtx(c));
  c.toDataURL = () => "data:image/png;base64,AAAA";
  return c;
}

const elements = {};
function el(id) {
  return elements[id] ||= {
    id, value: "0", checked: false, textContent: "", innerHTML: "",
    width: 300, height: 150,
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    getContext: () => makeCtx(elements[id]),
    _store: null,
  };
}

const modeRadios = ["original", "auto", "manual"].map((v) => ({
  value: v, checked: v === "auto", listeners: {},
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
}));

global.document = {
  getElementById: el,
  querySelector(sel) {
    if (sel === 'input[name="mode"]:checked') return modeRadios.find((r) => r.checked);
    if (sel === 'input[name="mode"][value="manual"]') return modeRadios[2];
    if (sel === "#statsTable tbody" || sel === "#reportTable tbody") {
      return elements[sel] ||= { innerHTML: "" };
    }
    return null;
  },
  querySelectorAll(sel) {
    return sel === 'input[name="mode"]' ? modeRadios : [];
  },
  createElement(tag) {
    if (tag === "canvas") return makeCanvas();
    return { style: {}, click: () => {}, set href(v) {}, download: "" };
  },
};

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "color.js"), "utf8") + "\n"
  + fs.readFileSync(path.join(root, "app.js"), "utf8");
const api = eval(src + `
;({ state, analyze, afterLoad, refresh, exportPng, makeDemoShots, srgbToLinear, linearToSrgb });`);

function makeImage(fn, w = 120, h = 90) {
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = fn(x, y, w, h);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  return img;
}
function scene(x, y, w, h) {
  if (y < h * 0.4) { const v = Math.round(60 + 140 * (x / w)); return [v, v, v]; }
  if (y < h * 0.7) return [210, 150, 110];
  return [250, 248, 245];
}
function cast(img, gr, gg, gb, ev) {
  const out = new ImageData(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = api.srgbToLinear(img.data[i] / 255) * gr * ev;
    const g = api.srgbToLinear(img.data[i + 1] / 255) * gg * ev;
    const b = api.srgbToLinear(img.data[i + 2] / 255) * gb * ev;
    out.data[i] = Math.round(255 * Math.min(1, api.linearToSrgb(r)));
    out.data[i + 1] = Math.round(255 * Math.min(1, api.linearToSrgb(g)));
    out.data[i + 2] = Math.round(255 * Math.min(1, api.linearToSrgb(b)));
    out.data[i + 3] = 255;
  }
  return out;
}

const base = makeImage(scene);
const wrap = (data) => {
  const cv = makeCanvas();
  cv.getContext().putImageData(data, 0, 0);
  return { data, canvas: cv };
};
api.state.imgA = wrap(cast(base, 1.30, 1.02, 0.70, 1.0));
api.state.imgB = wrap(cast(base, 0.80, 0.98, 1.28, 0.85));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); }
  catch (e) { failures++; console.log("FAIL  " + name + "  " + e.message); }
}

check("afterLoad 全链路（统计+预览+报告）", () => api.afterLoad());
check("统计表渲染非空", () => {
  if (!elements["#statsTable tbody"].innerHTML.includes("色温")) throw new Error("统计表缺少色温行");
});
check("报告表渲染非空", () => {
  if (!elements["#reportTable tbody"].innerHTML.includes("ΔE")) throw new Error("报告缺少 ΔE 行");
});
check("切换原片模式", () => { modeRadios.forEach((r) => r.checked = r.value === "original"); api.refresh(); });
check("切换手动微调模式", () => {
  modeRadios.forEach((r) => r.checked = r.value === "manual");
  elements.adjTemp.value = "20"; elements.adjExp.value = "50";
  api.refresh();
});
check("反向匹配 B→A", () => { elements.refDir.value = "BtoA"; api.refresh(); });
check("导出 PNG 不抛异常", () => api.exportPng());
check("演示镜头生成", () => api.makeDemoShots());

process.exit(failures ? 1 : 0);
