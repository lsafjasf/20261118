/* Node 冒烟测试: 验证模拟器 / 指标 / 抖动缓冲核心逻辑 */
const path = require("path");
require(path.join(__dirname, "..", "js", "rng.js"));
const sim = require(path.join(__dirname, "..", "js", "simulator.js"));
const metrics = require(path.join(__dirname, "..", "js", "metrics.js"));
const jb = require(path.join(__dirname, "..", "js", "jitterbuffer.js"));

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
  if (!ok) failures++;
}

const cfg = {
  streams: 2, duration: 10, ptime: 20, jitterMs: 15,
  lossPct: 3, reorderPct: 2, uneven: "none", seed: 42,
};

const r1 = sim.simulate(cfg);
const r2 = sim.simulate(cfg);
check("相同种子产生相同包序列",
  JSON.stringify(r1.streams[0].arrived.map((p) => p.seq)) ===
  JSON.stringify(r2.streams[0].arrived.map((p) => p.seq)));

const s0 = r1.streams[0];
check("发送包数符合时长/ptime", s0.sent.length === 500, "sent=" + s0.sent.length);
check("到达 + 丢失 = 发送", s0.arrived.length + s0.lost.length === s0.sent.length);
check("到达按时间升序", s0.arrived.every((p, i, a) => i === 0 || a[i - 1].arrival <= p.arrival));

const m = metrics.analyzeAll(r1);
const m0 = m[0];
check("抖动 J 非负且有限", m0.jitter >= 0 && isFinite(m0.jitter), "J=" + m0.jitter.toFixed(2));
check("空洞数与丢包数一致", m0.gapCount === m0.lostCount,
  "gap=" + m0.gapCount + " lost=" + m0.lostCount);
check("重排次数 >= 0", m0.reorderCount >= 0, "reorder=" + m0.reorderCount);
check("平稳发送时诊断为网络或平稳", m0.diagClass !== "diag-sender", m0.diagnosis);

const cfgUneven = Object.assign({}, cfg, { uneven: "burst", jitterMs: 0, lossPct: 0, reorderPct: 0 });
const rU = sim.simulate(cfgUneven);
const mU = metrics.analyzeAll(rU)[0];
check("突发发送被诊断为发送端问题", mU.diagClass === "diag-sender", mU.diagnosis);

const deep = jb.runAll(r1, { strategy: "fixed", depth: 400 });
const shallow = jb.runAll(r1, { strategy: "fixed", depth: 0 });
check("深度 400ms 过期帧 <= 深度 0ms",
  deep[0].expiredCount <= shallow[0].expiredCount,
  "deep=" + deep[0].expiredCount + " shallow=" + shallow[0].expiredCount);
check("深度 400ms 平均延迟 > 深度 0ms",
  deep[0].avgDelay > shallow[0].avgDelay,
  deep[0].avgDelay.toFixed(1) + " vs " + shallow[0].avgDelay.toFixed(1));
check("播放数 + 过期数 = 到达数",
  deep[0].playedCount + deep[0].expiredCount === s0.arrived.length);

const ad = jb.runAll(r1, { strategy: "adaptive", depth: 200 });
check("自适应策略可运行且统计有效",
  ad[0].playedCount + ad[0].expiredCount === s0.arrived.length && ad[0].avgDelay >= 0);

check("生成 SR 与 RR 报告",
  r1.rtcp.some((r) => r.kind === "SR") && r1.rtcp.some((r) => r.kind === "RR"));
check("RR 报告回填了 jitter", r1.rtcp.filter((r) => r.kind === "RR").every((r) => r.jitter >= 0));

console.log(failures === 0 ? "\n全部通过" : "\n有 " + failures + " 项失败");
process.exit(failures === 0 ? 0 : 1);
