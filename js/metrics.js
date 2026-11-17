/*
 * 接收端指标:
 *  - RFC 3550 到达间隔抖动 J (按到达顺序递推)
 *  - 序列号空洞 (丢失事件聚合)
 *  - 重排次数 (到达时 seq 小于已见最大 seq)
 *  - 网络抖动 vs 发送 发送端不均匀打包 诊断
 */
(function (global) {
  function analyzeStream(stream, rtpClock) {
    const arr = stream.arrived;
    const tsToMs = 1000 / rtpClock;

    // --- RFC 3550 抖动: D = (R_i - R_{i-1}) - (S_i - S_{i-1}) ---
    let jitter = 0;
    const jitterSeries = [];
    for (let i = 1; i < arr.length; i++) {
      const dArrival = arr[i].arrival - arr[i - 1].arrival;
      const dRtp = (arr[i].rtpTs - arr[i - 1].rtpTs) * tsToMs;
      const D = dArrival - dRtp;
      jitter += (Math.abs(D) - jitter) / 16;
      jitterSeries.push({ t: arr[i].arrival, D, J: jitter });
    }

    // --- 序列号空洞: 按到达顺序扫描, 期望 seq 跳变 >1 即有空洞 ---
    const gaps = [];
    let maxSeq = null;
    let reorderCount = 0;
    const reorderEvents = [];
    const byIndex = new Map(arr.map((p) => [p.index, p]));
    for (const p of arr) {
      if (maxSeq === null) { maxSeq = p.seq; continue; }
      const expected = (maxSeq + 1) & 0xffff;
      if (p.seq === expected) {
        maxSeq = p.seq;
      } else {
        const fwd = (p.seq - maxSeq) & 0xffff;
        if (fwd > 0 && fwd < 0x8000) {
          // 前向跳变: 中间缺失 fwd-1 个序号
          const missing = [];
          for (let k = 1; k < fwd; k++) missing.push((maxSeq + k) & 0xffff);
          // 若缺失序号稍后才到达, 属于重排而非丢失; 这里先记录, 之后校正
          gaps.push({ atArrival: p.arrival, afterSeq: maxSeq, missing });
          maxSeq = p.seq;
        } else {
          // 序号回退: 乱序到达
          reorderCount++;
          reorderEvents.push({ seq: p.seq, arrival: p.arrival, index: p.index });
        }
      }
    }
    // 校正空洞: 缺失序号若实际到达了, 从重排角度看它, 空洞里剔除
    const arrivedSeqs = new Set(arr.map((p) => p.seq));
    const realGaps = [];
    for (const g of gaps) {
      const trulyLost = g.missing.filter((s) => !arrivedSeqs.has(s));
      if (trulyLost.length) realGaps.push({ atArrival: g.atArrival, seqs: trulyLost });
    }
    const lostCount = stream.lost.length;

    // --- 诊断: 网络抖动 vs 发送端不均匀打包 ---
    // 发送端规整度: 相邻(按发送序号)包的发送间隔相对 ptime 的偏差
    const sent = stream.sent;
    const ptime = sent.length > 1 ? (sent[sent.length - 1].sendTime - sent[0].sendTime) / (sent.length - 1) : 0;
    let sendDevSum = 0, sendDevSq = 0;
    for (let i = 1; i < sent.length; i++) {
      const dev = Math.abs((sent[i].sendTime - sent[i - 1].sendTime) - ptime);
      sendDevSum += dev; sendDevSq += dev * dev;
    }
    const n = Math.max(1, sent.length - 1);
    const sendDevMean = sendDevSum / n;
    const sendDevStd = Math.sqrt(Math.max(0, sendDevSq / n - sendDevMean * sendDevMean));

    // 网络侧贡献: |D| 的均值 (到达间隔与 RTP 间隔之差)
    let dSum = 0;
    for (const s of jitterSeries) dSum += Math.abs(s.D);
    const netJitterMean = jitterSeries.length ? dSum / jitterSeries.length : 0;

    let diagnosis, diagClass;
    if (sendDevMean > ptime * 0.25 && sendDevMean > netJitterMean * 0.8) {
      diagnosis = "发送端不均匀打包为主 (发送间隔偏差 " + sendDevMean.toFixed(1) + "ms)";
      diagClass = "diag-sender";
    } else if (netJitterMean > 2) {
      diagnosis = "网络抖动为主 (|D| 均值 " + netJitterMean.toFixed(1) + "ms)";
      diagClass = "diag-net";
    } else {
      diagnosis = "链路平稳";
      diagClass = "diag-ok";
    }

    return {
      ssrc: stream.ssrc,
      received: arr.length,
      sentCount: sent.length,
      lostCount,
      lossPct: sent.length ? (lostCount / sent.length) * 100 : 0,
      jitter,
      jitterSeries,
      gaps: realGaps,
      gapCount: realGaps.reduce((acc, g) => acc + g.seqs.length, 0),
      reorderCount,
      reorderEvents,
      sendDevMean,
      sendDevStd,
      netJitterMean,
      diagnosis,
      diagClass,
      ptime,
    };
  }

  function analyzeAll(simResult) {
    const rtpClock = global.RtpSimulator.RTP_CLOCK;
    const perStream = simResult.streams.map((s) => analyzeStream(s, rtpClock));
    // 回填 RR 报告中的 jitter 字段 (取报告时刻之前的最新 J)
    for (let i = 0; i < simResult.rtcp.length; i++) {
      const r = simResult.rtcp[i];
      if (r.kind !== "RR") continue;
      const m = perStream.find((x) => x.ssrc === r.ssrc);
      if (!m) continue;
      let j = 0;
      for (const s of m.jitterSeries) { if (s.t <= r.time) j = s.J; else break; }
      r.jitter = j;
    }
    return perStream;
  }

  const api = { analyzeStream, analyzeAll };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.JbMetrics = api;
})(typeof window !== "undefined" ? window : globalThis);
