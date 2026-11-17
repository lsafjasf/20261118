/* 主控: 读取配置, 模拟, 分析, 缓冲重放, 渲染 */
(function () {
  let simResult = null;
  let metrics = null;
  const replayRuns = [];

  function readSimCfg() {
    return {
      streams: parseInt(document.getElementById("cfg-streams").value, 10),
      duration: parseFloat(document.getElementById("cfg-duration").value),
      ptime: parseFloat(document.getElementById("cfg-ptime").value),
      jitterMs: parseFloat(document.getElementById("cfg-jitter").value),
      lossPct: parseFloat(document.getElementById("cfg-loss").value),
      reorderPct: parseFloat(document.getElementById("cfg-reorder").value),
      uneven: document.getElementById("cfg-uneven").value,
      seed: parseInt(document.getElementById("cfg-seed").value, 10),
    };
  }

  function readBufOpts() {
    return {
      strategy: document.getElementById("cfg-strategy").value,
      depth: parseFloat(document.getElementById("cfg-bufdepth").value),
    };
  }

  function runAll(recordHistory) {
    if (!simResult) return;
    const opts = readBufOpts();
    const bufResults = JitterBuffer.runAll(simResult, opts);
    JbUI.renderMetricsTable(metrics, bufResults);
    JbUI.renderTimelines(simResult, metrics, bufResults);
    JbUI.renderRtcpLog(simResult.rtcp);
    if (recordHistory) {
      replayRuns.push({
        strategy: opts.strategy === "adaptive" ? "自适应" : "固定",
        depth: opts.depth,
        perStream: bufResults.map(function (b) {
          return {
            ssrc: b.ssrc, expiredCount: b.expiredCount,
            avgDelay: b.avgDelay, p95Delay: b.p95Delay,
          };
        }),
      });
      JbUI.renderReplayHistory(replayRuns);
    }
  }

  function generate() {
    const cfg = readSimCfg();
    simResult = RtpSimulator.simulate(cfg);
    metrics = JbMetrics.analyzeAll(simResult);
    replayRuns.length = 0;
    JbUI.renderReplayHistory(replayRuns);
    runAll(true);
  }

  document.getElementById("btn-generate").addEventListener("click", generate);
  document.getElementById("btn-replay").addEventListener("click", function () { runAll(true); });
  document.getElementById("cfg-bufdepth").addEventListener("input", function (e) {
    document.getElementById("bufdepth-val").textContent = e.target.value + " ms";
  });
  document.getElementById("cfg-strategy").addEventListener("change", function () { runAll(false); });
  document.getElementById("cfg-bufdepth").addEventListener("change", function () { runAll(false); });
  window.addEventListener("resize", function () { if (simResult) runAll(false); });

  generate();
})();
