/* 人工修订：候选确认/排除、修订保护、导出。
   保护规则：重算阈值只刷新机器候选，已有人工决定按时间重叠重新挂载，
   没有对应候选时作为孤儿标注保留，绝不删除或覆盖。 */
(function (root) {
  "use strict";

  var VFA = root.VFA || (root.VFA = {});
  var Review = VFA.Review || (VFA.Review = {});
  VFA.Review = Review;

  Review.createStore = function () {
    return {
      videoName: null,
      annotations: [], /* {id, t0, t1, decision: confirmed|excluded, note, source, createdAt, updatedAt} */
      seq: 0
    };
  };

  function stamp() { return new Date().toISOString(); }

  Review.upsertFromCandidate = function (store, cand, decision, note) {
    var existing = store.annotations.find(function (a) {
      return Review.matchAnnotation(a, cand) != null;
    });
    if (existing) {
      existing.decision = decision;
      existing.note = note != null ? note : existing.note;
      existing.t0 = cand.t0;
      existing.t1 = cand.t1;
      existing.updatedAt = stamp();
      return existing;
    }
    var anno = {
      id: "anno-" + (++store.seq),
      t0: cand.t0,
      t1: cand.t1,
      decision: decision,
      note: note || "",
      source: cand.id,
      createdAt: stamp(),
      updatedAt: stamp()
    };
    store.annotations.push(anno);
    return anno;
  };

  Review.updateNote = function (store, annoId, note) {
    var anno = store.annotations.find(function (a) { return a.id === annoId; });
    if (anno) {
      anno.note = note;
      anno.updatedAt = stamp();
    }
    return anno;
  };

  Review.remove = function (store, annoId) {
    var idx = store.annotations.findIndex(function (a) { return a.id === annoId; });
    if (idx >= 0) store.annotations.splice(idx, 1);
  };

  /* 时间重叠判定（与评估配对保持一致的容差思路，这里只用几何重叠）。 */
  Review.matchAnnotation = function (anno, cand) {
    var ov = VFA.Evaluate.overlap(anno, cand);
    if (ov <= 0) return null;
    return ov;
  };

  /* 阈值重算后把历史决定挂到新候选上，返回 {merged, orphans}。
     merged: 新候选 + annotation 字段；orphans: 找不到新候选的人工标注（保留）。 */
  Review.applyToCandidates = function (store, intervals) {
    var used = {};
    var merged = intervals.map(function (cand) {
      var best = null;
      store.annotations.forEach(function (anno) {
        if (used[anno.id]) return;
        var ov = Review.matchAnnotation(anno, cand);
        if (ov == null) return;
        if (!best || ov > best.ov) best = { anno: anno, ov: ov };
      });
      if (best) {
        used[best.anno.id] = true;
        return Object.assign({}, cand, {
          annotation: best.anno,
          reviewStatus: best.anno.decision
        });
      }
      return Object.assign({}, cand, { reviewStatus: "pending" });
    });
    var orphans = store.annotations.filter(function (a) { return !used[a.id]; });
    return { merged: merged, orphans: orphans };
  };

  Review.toExportJSON = function (payload) {
    return JSON.stringify({
      schema: "vfa-result/v1",
      exportedAt: stamp(),
      video: payload.video,
      sampling: payload.sampling,
      thresholds: payload.thresholds,
      periodicity: payload.periodicity,
      intervals: payload.intervals,
      review: payload.store.annotations
    }, null, 2);
  };

  Review.toCSV = function (intervals) {
    var header = [
      "id", "start_s", "end_s", "duration_s", "status",
      "confidence", "review_status", "lowlight", "reason"
    ];
    var lines = [header.join(",")];
    intervals.forEach(function (c) {
      lines.push([
        c.id, VFA.round3(c.t0), VFA.round3(c.t1), VFA.round3(c.duration),
        c.status, c.confidence, c.reviewStatus || "pending",
        c.lowlight ? "true" : "false", c.reason
      ].map(VFA.csvEscape).join(","));
    });
    return lines.join("\n");
  };

  Review.toAnnotationJSON = function (store) {
    return JSON.stringify({
      schema: "vfa-annotation/v1",
      exportedAt: stamp(),
      videoName: store.videoName,
      annotations: store.annotations
    }, null, 2);
  };

  Review.loadAnnotationJSON = function (store, data) {
    if (!data || data.schema !== "vfa-annotation/v1" || !Array.isArray(data.annotations)) {
      throw new Error("修订记录格式无法识别（需要 vfa-annotation/v1）");
    }
    data.annotations.forEach(function (a) {
      var anno = Object.assign({}, a, {
        id: "anno-" + (++store.seq),
        imported: true
      });
      store.annotations.push(anno);
    });
    return store;
  };

  Review.toHTMLReport = function (payload) {
    var rows = payload.intervals.map(function (c) {
      var tag = c.reviewStatus === "confirmed" ? "人工确认"
        : c.reviewStatus === "excluded" ? "人工排除"
        : c.status === "freeze" ? "疑似冻结" : "不确定";
      return "<tr><td>" + VFA.fmtTime(c.t0) + " – " + VFA.fmtTime(c.t1) +
        "</td><td>" + VFA.round2(c.duration) + "s</td><td>" + tag +
        "</td><td class='left'>" + escapeHtml(c.reason) + "</td></tr>";
    }).join("");
    return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'>" +
      "<title>检测报告</title><style>" +
      "body{font-family:sans-serif;margin:32px;color:#222}" +
      "table{border-collapse:collapse;width:100%;font-size:13px}" +
      "td,th{border:1px solid #bbb;padding:6px 8px}" +
      ".muted{color:#666;font-size:12px}</style></head><body>" +
      "<h2>本地视频重复画面分析报告</h2>" +
      "<p class='muted'>" + escapeHtml(payload.video && payload.video.name || "") +
      " · 导出时间 " + stamp() + "</p>" +
      "<table><thead><tr><th>区间</th><th>时长</th><th>结论</th><th>证据</th></tr>" +
      "</thead><tbody>" + rows + "</tbody></table></body></html>";
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Review;
  }
})(typeof window !== "undefined" ? window : globalThis);
