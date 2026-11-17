/**
 * 代理替换（conform / relink）前的映射表导出。
 * 同一份构建逻辑同时服务于 Node CLI（写文件）和浏览器（触发下载）。
 */

import { framesToTC, framesToSeconds } from './timecode.js';

const CSV_HEADERS = [
  'proxyId',
  'reelName',
  'proxyClipName',
  'sourceId',
  'sourceClipName',
  'matchedBy',
  'fps',
  'sourceStartFrame',
  'sourceStartTC',
  'totalFrames',
  'durationSec',
  'audioOffsetMs',
  'markerCount',
  'status',
  'issueTypes',
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 基于检查报告构建逐片段映射行 */
export function buildMappingRows(report) {
  return report.clipReports.map((clip) => {
    const original = clip.original;
    const proxy = clip.proxy;
    const fps = original?.fps ?? proxy.fps;
    return {
      proxyId: clip.proxyId,
      reelName: clip.reelName,
      proxyClipName: clip.clipName,
      sourceId: clip.sourceId ?? '',
      sourceClipName: original?.clipName ?? '',
      matchedBy: clip.matchedBy,
      fps,
      sourceStartFrame: proxy.sourceStartFrame,
      sourceStartTC: framesToTC(proxy.sourceStartFrame, fps),
      totalFrames: proxy.totalFrames,
      durationSec: framesToSeconds(proxy.totalFrames, fps).toFixed(3),
      audioOffsetMs: proxy.audioOffsetMs,
      markerCount: proxy.markers?.length ?? 0,
      status: clip.status,
      issueTypes: clip.issues.map((i) => i.type).join('|'),
    };
  });
}

export function toCSV(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADERS.map((key) => csvEscape(row[key])).join(','));
  }
  return `﻿${lines.join('\r\n')}`;
}

export function toJSON(report, rows) {
  return JSON.stringify({
    reportGeneratedAt: report.generatedAt,
    stage: 'PRE_CONFORM_MAPPING',
    summary: report.summary,
    tolerances: report.tolerances,
    mapping: rows,
  }, null, 2);
}

/** 浏览器端触发文件下载 */
export function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function exportMapping(report, format) {
  const rows = buildMappingRows(report);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (format === 'csv') {
    downloadTextFile(`proxy-mapping-pre-conform-${stamp}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
  } else {
    downloadTextFile(`proxy-mapping-pre-conform-${stamp}.json`, toJSON(report, rows), 'application/json');
  }
}
