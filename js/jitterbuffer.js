/*
 * 抖动缓冲模拟: 对同一份到达记录按指定策略重放。
 *  - fixed:    播放偏移 = 首包到达时刻 + 固定深度
 *  - adaptive: 播放偏移随 RFC3550 抖动估计调整, 目标深度 = clamp(4*J, 0, maxDepth)
 * 输出每包判决 (正常播放 / 过期丢弃)、缓冲占用时间线、延迟统计。
 */
(function (global) {
  function rtpMs(p, tsToMs) { return p.rtpTs * tsToMs; }

  function runBuffer(stream, opts) {
    const rtpClock = global.RtpSimulator.RTP_CLOCK;
    const tsToMs = 1000 / rtpClock;
    const arr = stream.arrived;
    const res = {
      ssrc: stream.ssrc,
      strategy: opts.strategy,
      depthLimit: opts.depth,
      packets: [],        // {seq, arrival, playout, status: 'played'|'expired', reordered}
      occupancy: [],      // {t, depth} 缓冲占用变化
      playoutEvents: [],  // {t, seq}
      expiredCount: 0,
      playedCount: 0,
      avgDelay: 0,
      p95Delay: 0,
      maxDelay: 0,
    };
    if (!arr.length) return res;

    let offset = null;         // playoutTime = rtpMs + offset
    let jitter = 0;            // 接收端在线抖动估计
    let prev = null;
    const inBuffer = [];       // 已到达未播放
    const events = [];

    for (const p of arr) {
      // 在线更新抖动估计
      if (prev) {
        const D = (p.arrival - prev.arrival) - (rtpMs(p, tsToMs) - rtpMs(prev, tsToMs));
        jitter += (Math.abs(D) - jitter) / 16;
      }
      prev = p;

      // 计算当前播放偏移
      let depth;
      if (opts.strategy === "adaptive") {
        depth = Math.min(opts.depth, Math.max(0, 4 * jitter));
      } else {
        depth = opts.depth;
      }
      const desired = p.arrival + depth - rtpMs(p, tsToMs);
      if (offset === null) offset = desired;
      else if (opts.strategy === "adaptive") {
        // 平滑调整, 且不允许已排程的播放时刻倒退到过去
        offset = Math.max(0.9 * offset + 0.1 * desired, p.arrival - rtpMs(p, tsToMs));
      }

      const playout = rtpMs(p, tsToMs) + offset;
      const status = p.arrival > playout ? "expired" : "played";
      const rec = {
        seq: p.seq, index: p.index, arrival: p.arrival, playout,
        status, reordered: !!p.injectedReorder, netDelay: p.netDelay,
      };
      res.packets.push(rec);
      if (status === "expired") res.expiredCount++;
      else {
        res.playedCount++;
        inBuffer.push(rec);
        events.push({ t: p.arrival, delta: +1 });
        events.push({ t: playout, delta: -1, seq: p.seq });
      }
    }

    // 缓冲占用时间线
    events.sort((a, b) => a.t - b.t || a.delta - b.delta);
    let depthNow = 0;
    for (const e of events) {
      depthNow = Math.max(0, depthNow + e.delta);
      res.occupancy.push({ t: e.t, depth: depthNow });
      if (e.delta === -1) res.playoutEvents.push({ t: e.t, seq: e.seq });
    }

    const delays = res.packets.filter((p) => p.status === "played")
      .map((p) => p.playout - p.arrival).sort((a, b) => a - b);
    if (delays.length) {
      res.avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
      res.p95Delay = delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.95))];
      res.maxDelay = delays[delays.length - 1];
    }
    return res;
  }

  function runAll(simResult, opts) {
    return simResult.streams.map((s) => runBuffer(s, opts));
  }

  const api = { runBuffer, runAll };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.JitterBuffer = api;
})(typeof window !== "undefined" ? window : globalThis);
