/* 用最小 DOM 桩验证 ui.js 渲染逻辑不抛异常 */
const path = require("path");

function makeCtx() {
  const noop = () => {};
  return {
    scale: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
    fill: noop, fillRect: noop, fillText: noop, closePath: noop,
    set strokeStyle(v) {}, set fillStyle(v) {}, set font(v) {},
    set globalAlpha(v) {}, set lineWidth(v) {},
  };
}
function makeEl(tag) {
  return {
    tag, children: [], style: {}, className: "", textContent: "",
    innerHTML: "", clientWidth: 900, width: 0, height: 0,
    appendChild(c) { this.children.push(c); },
    getContext: () => makeCtx(),
    addEventListener: () => {},
  };
}
const elems = {};
const ids = [
  "cfg-streams", "cfg-duration", "cfg-ptime", "cfg-jitter", "cfg-loss",
  "cfg-reorder", "cfg-uneven", "cfg-seed", "cfg-strategy", "cfg-bufdepth",
  "bufdepth-val", "btn-generate", "btn-replay", "rtcp-log", "timelines",
  "replay-history",
];
for (const id of ids) elems[id] = makeEl("div");
const values = {
  "cfg-streams": "2", "cfg-duration": "5", "cfg-ptime": "20",
  "cfg-jitter": "15", "cfg-loss": "3", "cfg-reorder": "2",
  "cfg-uneven": "burst", "cfg-seed": "7", "cfg-strategy": "adaptive",
  "cfg-bufdepth": "120",
};
for (const id of ids) elems[id].value = values[id] || "";
elems["metrics-table"] = makeEl("table");
elems["metrics-table"].querySelector = () => makeEl("tbody");

global.document = {
  getElementById: (id) => elems[id],
  querySelector: (sel) => elems["metrics-table"].querySelector(),
  createElement: (tag) => makeEl(tag),
};
global.window = global;
global.devicePixelRatio = 1;
global.addEventListener = () => {};

require(path.join(__dirname, "..", "js", "rng.js"));
require(path.join(__dirname, "..", "js", "simulator.js"));
require(path.join(__dirname, "..", "js", "metrics.js"));
require(path.join(__dirname, "..", "js", "jitterbuffer.js"));
require(path.join(__dirname, "..", "js", "ui.js"));
require(path.join(__dirname, "..", "js", "main.js"));

const tl = elems["timelines"];
if (!tl.children.length) throw new Error("时间轴未渲染任何流");
if (!elems["rtcp-log"].innerHTML.includes("[SR]")) throw new Error("RTCP 日志缺少 SR");
if (!elems["replay-history"].innerHTML.includes("自适应")) throw new Error("重放历史未记录");
console.log("PASS  DOM 桩渲染: 流画布=" + tl.children.length +
  ", RTCP 日志与重放历史均正常");
