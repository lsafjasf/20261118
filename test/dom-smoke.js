"use strict";

/* 1) 校验脚本引用的 DOM id 都在 index.html 中声明。 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
var declared = new Set();
var re = /id="([^"]+)"/g, m;
while ((m = re.exec(html))) declared.add(m[1]);

var missing = [];
fs.readdirSync(path.join(root, "js")).forEach(function (f) {
  var src = fs.readFileSync(path.join(root, "js", f), "utf8");
  var r = /getElementById\("([^"]+)"\)/g, q;
  while ((q = r.exec(src))) {
    if (!declared.has(q[1])) missing.push(f + " -> #" + q[1]);
  }
});
if (missing.length) {
  console.error("缺失的 DOM id：\n" + missing.join("\n"));
  process.exit(1);
}
console.log("✓ 所有 getElementById 引用均在 index.html 中声明");

/* 2) 最小 DOM/Canvas stub，跑通 App.readConfig -> analyze -> Review 链路。 */
function stubEl(value) {
  return { value: String(value), hidden: false, textContent: "", innerHTML: "",
    addEventListener: function () {}, onclick: null, style: {}, dataset: {} };
}
global.document = {
  getElementById: function (id) {
    var map = {
      "cfg-preset": "standard", "cfg-step": 0.1, "cfg-width": 160,
      "cfg-min-dur": 0.3,
      "t-luma": 2.5, "t-edge": 0.01, "t-motion": 0.02, "t-lowlight": 32,
      video: { videoWidth: 320, videoHeight: 180 },
      "panel-results": {}, "panel-eval": {}, "panel-review": {},
      "btn-load-gt": {}, "analyze-progress": {}, timeline: { parentElement: { clientWidth: 900 } }
    };
    if (id in map) {
      var v = map[id];
      return typeof v === "object" ? v : stubEl(v);
    }
    return stubEl("");
  },
  createElement: function () { return {}; },
  body: { appendChild: function () {}, removeChild: function () {} }
};
global.window = global;

require("../js/util.js");
require("../js/metrics.js");
require("../js/detect.js");
require("../js/evaluate.js");
require("../js/review.js");
require("../js/app-core.js");

var VFA = global.VFA;
var synth = require("./synth.js").buildClip();
VFA.App.state.frames = synth.frames;
VFA.App.state.duration = 16.8;
var cfg = VFA.App.readConfig();
if (cfg.luma !== 2.5 || cfg.minDuration !== 0.3) {
  console.error("✗ readConfig 取值错误"); process.exit(1);
}
VFA.App.analyze(cfg);
if (!VFA.App.state.result.intervals.length) {
  console.error("✗ analyze 未产出候选"); process.exit(1);
}
if (!VFA.App.state.merged.every(function (c) { return c.reviewStatus === "pending"; })) {
  console.error("✗ 新候选默认应为 pending"); process.exit(1);
}
console.log("✓ App 分析链路产出 " + VFA.App.state.merged.length + " 个候选，默认 pending");

/* 3) 模拟人工确认后再次 analyze，决定必须保留。 */
var Review = VFA.Review;
var target = VFA.App.state.merged.find(function (c) { return c.t0 <= 5.3; });
Review.upsertFromCandidate(VFA.App.state.reviewStore, target, "confirmed", "smoke");
VFA.App.analyze(cfg);
var kept = VFA.App.state.merged.some(function (c) {
  return c.reviewStatus === "confirmed" && c.annotation.note === "smoke";
});
if (!kept) { console.error("✗ 重算后人工确认丢失"); process.exit(1); }
console.log("✓ 重新分析后人工确认与备注保留");
console.log("\nDOM smoke 全部通过");
