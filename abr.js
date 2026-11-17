/*
 * 自适应码率(ABR)控制器 + 简化的 DASH 播放器仿真器。
 * 同时供浏览器界面(index.html)与 Node 验证脚本(validate.js)使用。
 */
(function (global) {
  'use strict';

  // 可用码率档位 (kbps)
  var BITRATES = [400, 800, 1500, 3000, 5000];
  var SEGMENT_DURATION = 4; // 每片段时间长 (s)

  var DEFAULTS = {
    upMargin: 1.3,        // 升级余量: 吞吐需 > 目标码率 * upMargin
    upConsecutive: 3,     // 升级需连续满足的片段数
    downMargin: 0.9,      // 吞吐 < 当前码率 * downMargin 即触发降级评估
    minBufferUp: 8,       // 升级所需的最小缓冲 (s)
    panicBuffer: 2.5,     // 缓冲低于该值时紧急降级 (s)
    jitterMax: 0.45,      // 抖动超过该值禁止升级
    jitterPanic: 0.9,     // 抖动超过该值直接降级
    cooldownAfterDown: 16,// 降级后的升级冷却时间 (s)
    switchCooldown: 6,    // 任意切换后的最小间隔 (s)
    ewmaAlpha: 0.35,      // 吞吐 EWMA 平滑系数
    startBuffer: 4,       // 起播所需缓冲 (s)
    resumeBuffer: 1.5,    // 卡顿后恢复播放所需缓冲 (s)
    maxBuffer: 30         // 缓冲上限 (s)
  };

  /**
   * ABR 控制器: 每个片段下载完成后调用 decide() 得到 升级/保持/降级 决策。
   */
  function AbrController(opts) {
    this.cfg = Object.assign({}, DEFAULTS, opts || {});
    this.level = 0;              // 从最低档起播, 快速起播
    this.upStreak = 0;           // 连续满足升级余量的片段数
    this.cooldownUntil = 0;      // 升级冷却截止时间
    this.lastSwitchAt = -1e9;    // 上次切换时间
    this.lastDecision = null;
  }

  AbrController.prototype.bitrate = function () {
    return BITRATES[this.level];
  };

  /**
   * @param state {now, throughputKbps, bufferSec, jitter}
   * @returns 决策记录(含本次使用的指标与冷却剩余时间)
   */
  AbrController.prototype.decide = function (state) {
    var cfg = this.cfg;
    var now = state.now;
    var tp = state.throughputKbps;
    var buf = state.bufferSec;
    var jit = state.jitter;
    var cur = BITRATES[this.level];
    var cooldownLeft = Math.max(0, this.cooldownUntil - now);
    var switchCooling = now - this.lastSwitchAt < cfg.switchCooldown;

    var action = 'hold';
    var reason = '指标平稳, 保持当前档位';
    var newLevel = this.level;

    // ---- 降级: 快速响应, 优先于一切 ----
    var danger = tp < cur * cfg.downMargin;
    var panic = buf < cfg.panicBuffer && tp < cur;
    var jitterBad = jit > cfg.jitterPanic;
    if ((danger || panic || jitterBad) && this.level > 0) {
      // 直接降到吞吐可承受的档位(留 20% 余量), 可一次降多档
      var target = this.level;
      while (target > 0 && BITRATES[target] * 1.2 > tp) target--;
      if (panic && target >= this.level) target = this.level - 1;
      if (target < this.level) {
        newLevel = target;
        action = 'down';
        reason = panic
          ? '缓冲告急(' + buf.toFixed(1) + 's), 快速降级'
          : jitterBad
            ? '播放抖动过大(' + jit.toFixed(2) + '), 降级'
            : '吞吐不足(' + Math.round(tp) + '<' + Math.round(cur * cfg.downMargin) + '), 降级';
      }
    }

    // ---- 升级: 需连续 upConsecutive 个片段满足余量, 且不在冷却期 ----
    if (action === 'hold' && this.level < BITRATES.length - 1) {
      var next = BITRATES[this.level + 1];
      var marginOk = tp > next * cfg.upMargin;
      var bufferOk = buf >= cfg.minBufferUp;
      var jitterOk = jit <= cfg.jitterMax;
      if (marginOk && bufferOk && jitterOk) {
        this.upStreak++;
      } else {
        this.upStreak = 0;
      }
      if (this.upStreak >= cfg.upConsecutive) {
        if (cooldownLeft > 0 || switchCooling) {
          reason = '升级条件已满足, 但冷却中(剩余 ' +
            Math.max(cooldownLeft, cfg.switchCooldown - (now - this.lastSwitchAt)).toFixed(1) + 's)';
        } else {
          newLevel = this.level + 1; // 一次只升一档, 配合冷却避免来回抖动
          action = 'up';
          reason = '连续 ' + this.upStreak + ' 片满足余量, 升级一档';
          this.upStreak = 0;
        }
      } else if (this.upStreak > 0) {
        reason = '升级计数 ' + this.upStreak + '/' + cfg.upConsecutive;
      }
    } else if (action === 'hold') {
      this.upStreak = 0;
    }

    if (newLevel !== this.level) {
      this.level = newLevel;
      this.lastSwitchAt = now;
      if (action === 'down') this.cooldownUntil = now + cfg.cooldownAfterDown;
    }

    this.lastDecision = {
      now: now,
      action: action,
      level: this.level,
      bitrate: BITRATES[this.level],
      throughput: tp,
      buffer: buf,
      jitter: jit,
      cooldownLeft: Math.max(0, this.cooldownUntil - now),
      upStreak: this.upStreak,
      reason: reason
    };
    return this.lastDecision;
  };

  /**
   * 播放器仿真器: 以 dt 步进模拟片段下载与播放消耗。
   * trace: [[tSec, kbps], ...] 阶梯带宽轨迹。
   */
  function simulate(trace, opts) {
    opts = opts || {};
    var cfg = Object.assign({}, DEFAULTS, opts.abr || {});
    var ctrl = new AbrController(cfg);
    var numSegments = opts.numSegments || 60;
    var dt = 0.1;

    function bandwidthAt(t) {
      var bw = trace[0][1];
      for (var i = 0; i < trace.length; i++) {
        if (trace[i][0] <= t) bw = trace[i][1];
        else break;
      }
      return bw;
    }

    var now = 0, buffer = 0, playing = false;
    var segIndex = 0, segRemain = 0, segActive = false; // 当前片段剩余 kbit
    var segStart = 0, segDlTimes = [];
    var tpEwma = 0, jitEwma = 0, avgDl = 0;
    var startupDelay = null, stall = 0, stallEvents = 0;
    var lastAbortAt = -1e9;
    var decisions = [], timeline = [];

    function startSegment() {
      segRemain = ctrl.bitrate() * SEGMENT_DURATION; // kbit
      segStart = now;
      segActive = true;
    }

    var maxTime = trace[trace.length - 1][0] + 120;
    while (segIndex < numSegments && now < maxTime) {
      var bw = bandwidthAt(now);
      var wasPlaying = playing;

      // 缓冲满时暂停下载(真实播放器行为), 留出整片空间后再继续
      if (!segActive && buffer <= cfg.maxBuffer - SEGMENT_DURATION) {
        startSegment();
      }

      // 紧急中止: 预计剩余下载时间超过可用缓冲, 立即降级重下(快速降级)
      if (segActive && ctrl.level > 0 && now - lastAbortAt > 2) {
        var remainTime = segRemain / Math.max(bw, 1);
        if (remainTime > buffer + 0.5) {
          tpEwma = tpEwma === 0 ? bw : cfg.ewmaAlpha * bw + (1 - cfg.ewmaAlpha) * tpEwma;
          var emergency = ctrl.decide({
            now: now, throughputKbps: Math.min(tpEwma, bw), bufferSec: buffer, jitter: jitEwma
          });
          emergency.segment = segIndex;
          emergency.aborted = true;
          decisions.push(emergency);
          if (emergency.action === 'down') {
            startSegment();
            lastAbortAt = now;
          }
        }
      }

      // 下载
      if (segActive) {
        segRemain -= Math.min(segRemain, bw * dt);
      }
      // 播放消耗
      if (playing) {
        buffer -= dt;
        if (buffer <= 0) {
          buffer = 0;
          playing = false; // 卡顿, 等待缓冲恢复
        }
      } else if (startupDelay !== null && buffer >= cfg.resumeBuffer && stallEvents > 0) {
        playing = true;
      }

      // 片段下载完成
      if (segActive && segRemain <= 1e-9) {
        segActive = false;
        var dlTime = Math.max(now - segStart, dt);
        var instTp = (ctrl.bitrate() * SEGMENT_DURATION) / dlTime;
        tpEwma = tpEwma === 0 ? instTp : cfg.ewmaAlpha * instTp + (1 - cfg.ewmaAlpha) * tpEwma;
        avgDl = avgDl === 0 ? dlTime : 0.3 * dlTime + 0.7 * avgDl;
        var dev = Math.abs(dlTime - avgDl) / Math.max(avgDl, 1e-6);
        jitEwma = 0.3 * dev + 0.7 * jitEwma;
        segDlTimes.push(dlTime);

        buffer = Math.min(buffer + SEGMENT_DURATION, cfg.maxBuffer);
        segIndex++;

        // 起播判定
        if (startupDelay === null && buffer >= cfg.startBuffer) {
          startupDelay = now;
          playing = true;
        }

        if (segIndex < numSegments) {
          var d = ctrl.decide({
            now: now, throughputKbps: tpEwma, bufferSec: buffer, jitter: jitEwma
          });
          d.segment = segIndex;
          decisions.push(d); // 下一片待缓冲低于上限后再开始
        }
      }

      // 统计卡顿
      if (startupDelay !== null && !playing) {
        stall += dt;
        if (wasPlaying) stallEvents++;
      }
      timeline.push({ t: now, bw: bw, buffer: buffer, level: ctrl.level, playing: playing });
      now += dt;
    }

    var switches = decisions.filter(function (d) { return d.action !== 'hold'; }).length;
    return {
      switches: switches,
      ups: decisions.filter(function (d) { return d.action === 'up'; }).length,
      downs: decisions.filter(function (d) { return d.action === 'down'; }).length,
      startupDelay: startupDelay === null ? Infinity : startupDelay,
      stallDuration: stall,
      stallEvents: stallEvents,
      decisions: decisions,
      timeline: timeline,
      finalLevel: ctrl.level,
      segments: segIndex
    };
  }

  var api = {
    BITRATES: BITRATES,
    SEGMENT_DURATION: SEGMENT_DURATION,
    DEFAULTS: DEFAULTS,
    AbrController: AbrController,
    simulate: simulate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ABR = api;
})(typeof window !== 'undefined' ? window : globalThis);
