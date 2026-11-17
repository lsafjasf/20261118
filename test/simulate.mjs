// 无头验证：分别注入带宽下降与主线程阻塞，输出最先升高的指标。
import { FaultSimulator } from "../js/simulator.js";
import { StutterDetector } from "../js/detector.js";

function runScenario(kind, opts = {}) {
  const { injectAtMs = 10000, faultMs = 20000, totalMs = 60000 } = opts;
  const sim = new FaultSimulator({ dtMs: 500, seed: 42 });
  const det = new StutterDetector();
  const events = [];
  det.onEvent = (e) => events.push(e);

  let injected = false;
  while (sim.t < totalMs) {
    if (!injected && sim.t >= injectAtMs) {
      sim.inject(kind, faultMs);
      injected = true;
    }
    det.push(sim.next());
  }
  if (det.openInterval) det.closeInterval(sim.t);

  return { kind, events, interval: det.intervals[0], det };
}

const fmt = (ms) => (ms == null ? "-" : (ms / 1000).toFixed(1) + "s");

let ok = true;
for (const kind of ["bandwidth", "mainthread"]) {
  const { interval, events, det } = runScenario(kind);
  const firstElev = events.find((e) => e.type === "elevate");
  const name = kind === "bandwidth" ? "带宽下降" : "主线程阻塞";
  console.log("\n=== 场景: " + name + " (" + kind + ") ===");
  const seq = events.filter((e) => e.type === "elevate")
    .map((e) => e.category + "@" + fmt(e.t)).join(" -> ");
  console.log("抬升序列: " + seq);
  if (!interval) {
    console.log("结果: 未检测到卡顿 [FAIL]");
    ok = false;
    continue;
  }
  console.log("卡顿区间: " + fmt(interval.start) + " ~ " + fmt(interval.end));
  console.log("首升指标: " + interval.attribution.label +
    " (类别 " + interval.attribution.category +
    ", 领先卡顿 " + fmt(interval.attribution.leadMs) + ")");
  console.log("证据窗口: " + fmt(interval.evidence.from) + " ~ " +
    fmt(interval.evidence.to) + ", 样本数 " + interval.evidence.samples.length);
  const recovered = events.some((e) => e.type === "stutter-end");
  const historyKept = det.intervals.length >= 1 && det.intervals[0].end !== null;
  console.log("恢复后告警停止: " + (recovered ? "OK" : "FAIL") +
    ", 历史区间保留: " + (historyKept ? "OK" : "FAIL"));
  if (!recovered || !historyKept) ok = false;

  const expect = kind === "bandwidth" ? "network" : "render";
  const pass = interval.attribution.category === expect &&
    firstElev && firstElev.category === expect;
  console.log("预期首升 " + expect + ": " + (pass ? "PASS" : "FAIL"));
  if (!pass) ok = false;
}

console.log("\n总体: " + (ok ? "全部通过" : "存在失败"));
process.exit(ok ? 0 : 1);
