/*
 * RTP/RTCP 发送端 + 网络模拟器。
 * 生成: 每流的 RTP 包发送记录、经过网络后的到达记录、周期性 SR/RR 报告。
 * 时间单位: 毫秒 (浮点)。RTP 时钟 90kHz 仅在报告里换算展示。
 */
(function (global) {
  const RTP_CLOCK = 90000;

  function simulateStream(cfg, streamIdx, rng) {
    const ssrc = 0x1000 + streamIdx;
    const totalPkts = Math.round((cfg.duration * 1000) / cfg.ptime);
    const baseDelay = 40 + streamIdx * 15; // 各流基础单向延迟不同
    const seq0 = Math.floor(rng.range(0, 60000));
    const ts0 = Math.floor(rng.range(0, 1e9));
    const tsPerPkt = (cfg.ptime / 1000) * RTP_CLOCK;

    const sent = [];
    let sendClock = 0;
    for (let i = 0; i < totalPkts; i++) {
      // 发送端不均匀打包建模
      if (cfg.uneven === "vptime") {
        // 可变 ptime: 实际打包间隔在 0.4x ~ 1.8x 间漂移, 但 RTP 时间戳仍按真实采样时刻
        sendClock += i === 0 ? 0 : cfg.ptime * rng.range(0.4, 1.8);
      } else if (cfg.uneven === "burst") {
        // 突发: 每 5 个包攒一波同时发出
        sendClock = Math.floor(i / 5) * cfg.ptime * 5;
      } else {
        sendClock = i * cfg.ptime;
      }
      sent.push({
        ssrc,
        seq: (seq0 + i) & 0xffff,
        index: i,
        rtpTs: Math.round(ts0 + i * tsPerPkt), // 时间戳始终反映采样时刻
        sendTime: sendClock,                   // 实际离开发送端的时刻
      });
    }

    // 网络: 延迟抖动 + 丢包 + 重排
    const arrived = [];
    const lost = [];
    for (const p of sent) {
      if (rng.chance(cfg.lossPct / 100)) { lost.push(p); continue; }
      let delay = baseDelay + Math.max(0, rng.gauss(0, cfg.jitterMs));
      let reordered = false;
      if (rng.chance(cfg.reorderPct / 100)) {
        delay += cfg.ptime * rng.range(1.2, 3.0); // 额外延迟导致乱序
        reordered = true;
      }
      arrived.push(Object.assign({}, p, {
        arrival: p.sendTime + delay,
        netDelay: delay,
        injectedReorder: reordered,
      }));
    }
    arrived.sort((a, b) => a.arrival - b.arrival);
    return { ssrc, sent, arrived, lost, tsPerPkt, baseDelay };
  }

  // 周期性 RTCP: 发送端 SR (每 2s), 接收端 RR (每 2s, 偏移 1s)
  function simulateRtcp(streams, cfg) {
    const reports = [];
    const period = 2000;
    for (let t = 0; t <= cfg.duration * 1000; t += period) {
      for (const s of streams) {
        const sentSoFar = s.sent.filter((p) => p.sendTime <= t);
        if (sentSoFar.length === 0) continue;
        const last = sentSoFar[sentSoFar.length - 1];
        reports.push({
          kind: "SR", ssrc: s.ssrc, time: t,
          ntp: t, rtpTs: last.rtpTs,
          pktCount: sentSoFar.length,
          octets: sentSoFar.length * 160,
        });
      }
      for (const s of streams) {
        const recvSoFar = s.arrived.filter((p) => p.arrival <= t + period / 2);
        if (recvSoFar.length === 0) continue;
        const sentCount = s.sent.filter((p) => p.sendTime <= t + period / 2).length;
        const cumLost = Math.max(0, sentCount - recvSoFar.length);
        reports.push({
          kind: "RR", ssrc: s.ssrc, time: t + period / 2,
          fractionLost: sentCount ? cumLost / sentCount : 0,
          cumLost,
          highestSeq: recvSoFar[recvSoFar.length - 1].seq,
          jitter: 0, // 由 metrics 模块回填
          lsr: t, dlsr: period / 2,
        });
      }
    }
    reports.sort((a, b) => a.time - b.time);
    return reports;
  }

  function simulate(cfg) {
    const rng = global.RngUtil.makeRng(cfg.seed);
    const streams = [];
    for (let i = 0; i < cfg.streams; i++) streams.push(simulateStream(cfg, i, rng));
    const rtcp = simulateRtcp(streams, cfg);
    return { cfg, streams, rtcp };
  }

  const api = { simulate, RTP_CLOCK };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.RtpSimulator = api;
})(typeof window !== "undefined" ? window : globalThis);
