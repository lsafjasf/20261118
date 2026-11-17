// 将 RTCInboundRtpVideoStream 等原始计数器归一化为四类卡顿相关指标。
// 输入为相邻两次 getStats 快照，输出带时间戳的速率/均值样本。

export const CATEGORIES = ["network", "decode", "jitterBuffer", "render"];

export const CATEGORY_LABELS = {
  network: "网络丢包",
  decode: "解码耗时",
  jitterBuffer: "抖动缓冲",
  render: "渲染等待",
};

export function emptySample(t) {
  return {
    t,
    network: { lossRate: 0, jitterMs: 0, rttMs: 0 },
    decode: { decodeMs: 0 },
    jitterBuffer: { jbDelayMs: 0 },
    render: { fps: 0, droppedDelta: 0, freezeMs: 0 },
  };
}

// raw: { packetsReceived, packetsLost, jitter, framesDecoded, totalDecodeTime,
//        jitterBufferDelay, jitterBufferEmittedCount, framesPerSecond,
//        framesDropped, freezeCount, totalFreezesDuration, roundTripTime }
export function diffSample(prev, curr, tMs) {
  const dt = Math.max((curr.time - prev.time) / 1000, 1e-3);
  const dRecv = curr.packetsReceived - prev.packetsReceived;
  const dLost = curr.packetsLost - prev.packetsLost;
  const dDecoded = curr.framesDecoded - prev.framesDecoded;
  const dDecodeTime = curr.totalDecodeTime - prev.totalDecodeTime;
  const dJbDelay = curr.jitterBufferDelay - prev.jitterBufferDelay;
  const dJbEmitted = curr.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
  const dFreezeCount = curr.freezeCount - prev.freezeCount;
  const dFreezeDur = curr.totalFreezesDuration - prev.totalFreezesDuration;

  return {
    t: tMs,
    network: {
      lossRate: dRecv + dLost > 0 ? dLost / (dRecv + dLost) : 0,
      jitterMs: curr.jitter * 1000,
      rttMs: (curr.roundTripTime || 0) * 1000,
    },
    decode: {
      decodeMs: dDecoded > 0 ? (dDecodeTime / dDecoded) * 1000 : 0,
    },
    jitterBuffer: {
      jbDelayMs: dJbEmitted > 0 ? (dJbDelay / dJbEmitted) * 1000 : 0,
    },
    render: {
      fps: curr.framesPerSecond || dDecoded / dt,
      droppedDelta: curr.framesDropped - prev.framesDropped,
      freezeMs: dFreezeCount > 0 ? dFreezeDur * 1000 : 0,
    },
  };
}

// 从 RTCStatsReport 提取视频 inbound-rtp 原始计数器（浏览器端使用）。
export function extractInboundVideo(stats, prevRemote) {
  let inbound = null;
  let remoteRtt = 0;
  stats.forEach((report) => {
    if (report.type === "inbound-rtp" && report.kind === "video") inbound = report;
    if (report.type === "remote-inbound-rtp" && report.kind === "video") {
      remoteRtt = report.roundTripTime || 0;
    }
  });
  if (!inbound) return null;
  return {
    time: inbound.timestamp,
    packetsReceived: inbound.packetsReceived || 0,
    packetsLost: inbound.packetsLost || 0,
    jitter: inbound.jitter || 0,
    framesDecoded: inbound.framesDecoded || 0,
    totalDecodeTime: inbound.totalDecodeTime || 0,
    jitterBufferDelay: inbound.jitterBufferDelay || 0,
    jitterBufferEmittedCount: inbound.jitterBufferEmittedCount || 0,
    framesPerSecond: inbound.framesPerSecond || 0,
    framesDropped: inbound.framesDropped || 0,
    freezeCount: inbound.freezeCount || 0,
    totalFreezesDuration: inbound.totalFreezesDuration || 0,
    roundTripTime: remoteRtt || (prevRemote && prevRemote.roundTripTime) || 0,
  };
}
