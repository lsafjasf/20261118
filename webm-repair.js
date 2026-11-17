/* webm-repair.js — WebM 分片修复与拼接（浏览器与 Node 通用）
 * 依赖 webm-ebml.js 的结构分析结果：
 *  - 从含 EBML 头的分片提取「头部段」（EBML + Segment 头 + Info/Tracks 等）
 *  - 收集所有完整 Cluster，按时间码去重并升序重排
 *  - 丢弃截断 Cluster 与尾部非 Cluster 元素（如失效的 Cues）
 * 输出修复后的字节流与逐 Cluster 报告（含修复前后字节长度）。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./webm-ebml.js'));
  } else {
    root.WebmRepair = factory(root.WebmEbml);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (EBML) {
  'use strict';

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  /* 在分片中定位「头部段」：从 EBML 元素起到第一个顶层 Cluster 之前的字节。
   * 返回 { chunkIndex, bytes } 或 null。 */
  function extractHeader(chunkList, analysis) {
    for (let i = 0; i < analysis.chunks.length; i++) {
      const entry = analysis.chunks[i];
      if (!entry.hasEbml) continue;
      // Cluster 通常嵌套在未知长度 Segment 内，用递归收集到的第一个 Cluster 定位头部末尾
      let headerEnd = chunkList[i].bytes.length;
      if (entry.clusters.length) headerEnd = entry.clusters[0].start;
      return { chunkIndex: i, bytes: chunkList[i].bytes.slice(0, headerEnd) };
    }
    return null;
  }

  /* 修复入口。
   * chunkList: [{ name, bytes: Uint8Array }]（按用户当前排列顺序）
   * 返回 { bytes, report }；无法修复时 bytes 为 null。 */
  function repairChunks(chunkList) {
    const analysis = EBML.analyzeChunks(chunkList);
    const notes = [];
    const clusterActions = [];

    const header = extractHeader(chunkList, analysis);
    if (!header) {
      notes.push('未在任何分片中找到 EBML 头，无法重建文件头');
      return {
        bytes: null,
        report: buildReport(analysis, null, clusterActions, notes),
      };
    }
    if (header.chunkIndex !== 0) {
      notes.push(
        `EBML 头来自第 ${header.chunkIndex + 1} 个分片「${chunkList[header.chunkIndex].name}」，`
        + '已自动移到输出开头'
      );
    }

    // 收集所有 Cluster，按 (时间码, 尺寸) 去重，再按时间码升序排列
    const seen = new Map();
    const kept = [];
    for (const cl of analysis.clusters) {
      const src = chunkList[cl.chunkIndex];
      const action = {
        timecode: cl.timecode,
        sourceChunk: cl.chunkIndex,
        sourceName: src ? src.name : `#${cl.chunkIndex}`,
        sourceOffset: cl.globalStart,
        size: cl.size,
        unknownSize: cl.unknownSize,
        action: 'keep',
      };
      if (cl.truncated) {
        action.action = 'drop-truncated';
        clusterActions.push(action);
        notes.push(
          `丢弃全局偏移 ${EBML.hex(cl.globalStart)} 处被截断的 Cluster`
          + (cl.timecode !== null ? `（时间码 ${cl.timecode}）` : '')
        );
        continue;
      }
      const key = cl.timecode === null ? `null:${cl.globalStart}` : `${cl.timecode}:${cl.size}`;
      if (cl.timecode !== null && seen.has(key)) {
        action.action = 'drop-duplicate';
        clusterActions.push(action);
        notes.push(
          `丢弃全局偏移 ${EBML.hex(cl.globalStart)} 处的重复 Cluster（时间码 ${cl.timecode}，`
          + `与偏移 ${EBML.hex(seen.get(key))} 处相同）`
        );
        continue;
      }
      seen.set(key, cl.globalStart);
      kept.push(cl);
      clusterActions.push(action);
    }

    const inputOrder = kept.map((cl) => cl.timecode);
    kept.sort((a, b) => {
      if (a.timecode === null && b.timecode === null) return a.globalStart - b.globalStart;
      if (a.timecode === null) return 1;
      if (b.timecode === null) return -1;
      return a.timecode - b.timecode;
    });
    const reordered = kept.some((cl, i) => cl.timecode !== inputOrder[i]);
    if (reordered) {
      notes.push(`Cluster 已按时间码升序重排（原顺序：${inputOrder.join(', ')}）`);
    }

    const parts = [header.bytes];
    for (const cl of kept) {
      parts.push(chunkList[cl.chunkIndex].bytes.slice(cl.start, cl.end));
    }
    const bytes = concat(parts);

    const report = buildReport(analysis, { header, kept, bytes }, clusterActions, notes);
    return { bytes, report };
  }

  function buildReport(analysis, result, clusterActions, notes) {
    const inputBytes = analysis.totalBytes;
    const outputBytes = result ? result.bytes.length : 0;
    return {
      inputBytes,
      outputBytes,
      headerBytes: result ? result.header.bytes.length : 0,
      headerSourceChunk: result ? result.header.chunkIndex : -1,
      clusterCount: result ? result.kept.length : 0,
      timecodes: result ? result.kept.map((cl) => cl.timecode) : [],
      clusters: clusterActions,
      notes,
      issues: analysis.issues,
    };
  }

  /* 按当前顺序原样拼接（不修复），用于对照。 */
  function mergeChunks(chunkList) {
    return concat(chunkList.map((c) => c.bytes));
  }

  /* 生成人类可读的文本报告。 */
  function formatReport(analysis, repairReport) {
    const lines = [];
    lines.push('=== WebM 分片结构诊断报告 ===');
    lines.push(`分片数: ${analysis.chunks.length}`);
    lines.push(`修复前总字节数: ${analysis.totalBytes}`);
    if (repairReport) {
      lines.push(`修复后字节数: ${repairReport.outputBytes}`);
      lines.push(`头部段字节数: ${repairReport.headerBytes}`
        + `（来自分片 #${repairReport.headerSourceChunk}）`);
      lines.push(`保留 Cluster 数: ${repairReport.clusterCount}`);
      lines.push(`Cluster 时间码序列: [${repairReport.timecodes.join(', ')}]`);
    }
    lines.push('');
    lines.push('--- 结构问题（含全局字节偏移） ---');
    if (analysis.issues.length === 0) {
      lines.push('（无）');
    }
    for (const issue of analysis.issues) {
      lines.push(`[${issue.level}] ${issue.code} @ ${EBML.hex(issue.offset)}: ${issue.message}`);
    }
    if (repairReport) {
      lines.push('');
      lines.push('--- 逐 Cluster 处理 ---');
      for (const cl of repairReport.clusters) {
        lines.push(
          `时间码 ${cl.timecode} | 来源分片 ${cl.sourceName} | 偏移 ${EBML.hex(cl.sourceOffset)}`
          + ` | ${cl.size} 字节 | ${cl.action}`
        );
      }
      if (repairReport.notes.length) {
        lines.push('');
        lines.push('--- 修复说明 ---');
        for (const note of repairReport.notes) lines.push(`* ${note}`);
      }
    }
    return lines.join('\n');
  }

  return { repairChunks, mergeChunks, formatReport, concat };
});
