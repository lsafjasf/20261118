/*
 * 内置验证样例（Node 与浏览器共用）。
 * 时间单位：90kHz timescale tick，帧率 25fps => 帧间隔 3600 tick。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TsSamples = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TICK = 3600; // 90kHz / 25fps

  /**
   * 生成 IBBPBBP... 的 B 帧序列（解码顺序）。
   * GOP 结构：I B B P B B P ...，M=3（两个连续 B 帧）。
   * 解码顺序：I0 P3 B1 B2 P6 B4 B5 P9 B7 B8 ...
   * DTS 按解码顺序递增，PTS = 展示位置 × TICK。
   */
  function makeBFrameSample(gopCount) {
    var packets = [];
    var dts = 0;
    var nextI = 0; // 下一个 I/P 的展示位置
    var g, b;
    // 首帧 I
    packets.push({ dts: dts, pts: 0, type: "I" });
    dts += TICK;
    nextI = 3;
    for (g = 0; g < gopCount; g++) {
      // 前向参考帧 P（展示位置 nextI），先解码
      packets.push({ dts: dts, pts: nextI * TICK, type: "P" });
      dts += TICK;
      // 两个 B 帧（展示位置 nextI-2, nextI-1），后解码
      for (b = nextI - 2; b < nextI; b++) {
        packets.push({ dts: dts, pts: b * TICK, type: "B" });
        dts += TICK;
      }
      nextI += 3;
    }
    return packets;
  }

  /**
   * 人为打乱时间戳的异常样例，包含：
   *  - 正常开头（无 B 帧，DTS=PTS）
   *  - 包 4：负 DTS
   *  - 包 6：重复 PTS
   *  - 包 8：DTS 回退（非单调）
   *  - 包 10：过大间隔
   *  - 包 12 起：PTS 随机打乱
   */
  function makeShuffledSample() {
    var pts = [];
    var i;
    for (i = 0; i < 20; i++) pts.push(i * TICK);
    // 打乱后 8 帧的 PTS
    var tail = pts.slice(12);
    for (i = tail.length - 1; i > 0; i--) {
      var j = (i * 7 + 3) % (i + 1); // 确定性伪随机
      var t = tail[i]; tail[i] = tail[j]; tail[j] = t;
    }
    for (i = 12; i < 20; i++) pts[i] = tail[i - 12];

    var packets = [];
    for (i = 0; i < 20; i++) {
      packets.push({ dts: i * TICK, pts: pts[i], type: "?" });
    }
    packets[4].dts = -TICK;              // 负时间
    packets[6].pts = packets[5].pts;     // 重复 PTS
    packets[8].dts = packets[7].dts - TICK; // DTS 回退
    packets[10].dts += TICK * 20;        // 过大间隔（DTS）
    packets[10].pts += TICK * 20;        // 过大间隔（PTS）
    return packets;
  }

  return {
    TICK: TICK,
    makeBFrameSample: makeBFrameSample,
    makeShuffledSample: makeShuffledSample
  };
});
