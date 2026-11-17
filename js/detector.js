// 卡顿检测与归因：滚动基线 -> 分类抬升检测 -> 卡顿事件 -> 首升指标归因。
// DOM 无关，可在 Node 中直接运行用于无头验证。

import { CATEGORIES, CATEGORY_LABELS } from "./stats-normalize.js";

const EVIDENCE_SPAN_MS = 10_000; // 卡顿点前后各 10 秒
const RECOVER_SAMPLES = 4; // 连续正常样本数判定恢复

// 每个类别用于抬升判定的主指标与阈值（相对滚动基线的倍数 + 绝对下限）
const ELEVATION_RULES = {
  network: { pick: (s) => s.network.lossRate, absMin: 0.02, ratio: 3 },
  decode: { pick: (s) => s.decode.decodeMs, absMin: 12, ratio: 2 },
  jitterBuffer: { pick: (s) => s.jitterBuffer.jbDelayMs, absMin: 60, ratio: 1.8 },
  render: { pick: (s) => s.render.droppedDelta + s.render.freezeMs / 100, absMin: 2, ratio: 2 },
};

export class StutterDetector {
  constructor({ baselineWindow = 40 } = {}) {
    this.baselineWindow = baselineWindow;
    this.history = []; // 所有样本
    this.elevations = []; // {category, start, end|null}
    this.openElevation = {}; // category -> elevation 记录
    this.intervals = []; // 卡顿异常区间 {id,start,end|null,attribution,evidence}
    this.openInterval = null;
    this.normalStreak = 0;
    this.onEvent = null; // 回调 {type: 'stutter-start'|'stutter-end'|'elevate', ...}
  }

  baseline(category) {
    const rule = ELEVATION_RULES[category];
    const vals = this.history.slice(-this.baselineWindow).map(rule.pick);
    if (!vals.length) return 0;
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  isElevated(category, sample) {
    const rule = ELEVATION_RULES[category];
    const v = rule.pick(sample);
    const base = this.baseline(category);
    return v >= rule.absMin && v >= Math.max(base * rule.ratio, rule.absMin);
  }

  isStuttering(sample) {
    const r = sample.render;
    return r.freezeMs > 150 || r.droppedDelta >= 3 || (r.fps > 0 && r.fps < 8);
  }

  push(sample) {
    this.history.push(sample);

    for (const cat of CATEGORIES) {
      const elevated = this.isElevated(cat, sample);
      const open = this.openElevation[cat];
      if (elevated && !open) {
        const rec = { category: cat, start: sample.t, end: null };
        this.elevations.push(rec);
        this.openElevation[cat] = rec;
        this.emit({ type: "elevate", category: cat, t: sample.t });
      } else if (!elevated && open) {
        open.end = sample.t;
        delete this.openElevation[cat];
      }
    }

    const stuttering = this.isStuttering(sample);
    if (stuttering && !this.openInterval) {
      this.openInterval = {
        id: this.intervals.length + 1,
        start: sample.t,
        end: null,
        attribution: null,
        evidence: null,
      };
      this.intervals.push(this.openInterval);
      this.normalStreak = 0;
      this.emit({ type: "stutter-start", interval: this.openInterval });
    } else if (stuttering && this.openInterval) {
      this.normalStreak = 0;
    } else if (!stuttering && this.openInterval) {
      this.normalStreak += 1;
      if (this.normalStreak >= RECOVER_SAMPLES) {
        this.closeInterval(sample.t);
      }
    }
  }

  closeInterval(t) {
    const iv = this.openInterval;
    if (!iv) return;
    iv.end = t;
    iv.attribution = this.attribute(iv);
    iv.evidence = this.evidenceWindow(iv);
    this.openInterval = null;
    this.normalStreak = 0;
    this.emit({ type: "stutter-end", interval: iv });
  }

  // 归因：卡顿开始前 10s 内，最早抬升的类别即“最先升高的指标”
  attribute(interval) {
    const windowStart = interval.start - EVIDENCE_SPAN_MS;
    const candidates = this.elevations.filter(
      (e) => e.start <= interval.start && (e.end === null || e.end >= windowStart)
    );
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.start - b.start);
    const first = candidates[0];
    return {
      category: first.category,
      label: CATEGORY_LABELS[first.category],
      elevatedAt: first.start,
      leadMs: interval.start - first.start,
    };
  }

  evidenceWindow(interval) {
    const from = interval.start - EVIDENCE_SPAN_MS;
    const to = (interval.end || interval.start) + EVIDENCE_SPAN_MS;
    return {
      from,
      to,
      samples: this.history.filter((s) => s.t >= from && s.t <= to),
      elevations: this.elevations.filter(
        (e) => e.start <= to && (e.end === null || e.end >= from)
      ),
    };
  }

  emit(evt) {
    if (this.onEvent) this.onEvent(evt);
  }
}
