import { escapeCsv } from "./glyphs";
import { formatTimestamp } from "./subtitles";

export function downloadText(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function firstAppearance(glyph) {
  return formatTimestamp(glyph.firstCue.start);
}

function affectedLines(glyph) {
  return glyph.affectedCues
    .map(
      (cue) =>
        `${cue.file} #${String(cue.index).padStart(2, "0")} ${formatTimestamp(cue.start)} ${cue.text.replaceAll("\n", " / ")}`,
    )
    .join(" | ");
}

export function buildMissingReportCsv(summary, font) {
  const rows = [
    [
      "字符",
      "Unicode",
      "对应语言",
      "首次出现时间",
      "首次出现字幕行",
      "影响字幕行数",
      "可能影响的字幕行",
      "选定时字体",
    ],
    ...summary.missing.map((glyph) => [
      glyph.char,
      glyph.unicode,
      glyph.language.label,
      firstAppearance(glyph),
      `${glyph.firstCue.file} #${String(glyph.firstCue.index).padStart(2, "0")}`,
      glyph.affectedCues.length,
      affectedLines(glyph),
      `${font.name} ${font.style}`,
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}`;
}

export function buildCandidateCsv(candidates) {
  const rows = [
    [
      "候选字体",
      "样式",
      "格式",
      "许可证",
      "覆盖当前字符",
      "当前字符总数",
      "覆盖率",
      "完整覆盖",
      "剩余缺失 Unicode",
      "文件",
    ],
    ...candidates.map((candidate) => [
      candidate.descriptor.name,
      candidate.descriptor.style,
      candidate.descriptor.format,
      candidate.descriptor.license,
      `${candidate.coveredCount}/${candidate.missingCount + candidate.coveredCount}`,
      candidate.missingCount,
      `${candidate.coveragePercent.toFixed(2)}%`,
      candidate.missingCount === 0 ? "是" : "否",
      candidate.missing.map((glyph) => glyph.unicode).join(" "),
      candidate.descriptor.fileName,
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}`;
}

export function buildAuditJson(summary, font, files) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      font: {
        name: font.name,
        style: font.style,
        file: font.fileName,
      },
      subtitleFiles: files.map((file) => file.name),
      coverage: {
        scanned: summary.total,
        covered: summary.coveredCount,
        missing: summary.missingCount,
        percentage: Number(summary.coveragePercent.toFixed(2)),
      },
      missing: summary.missing.map((glyph) => ({
        char: glyph.char,
        unicode: glyph.unicode,
        language: glyph.language.label,
        firstAppearance: {
          seconds: glyph.firstCue.start,
          timestamp: formatTimestamp(glyph.firstCue.start),
          file: glyph.firstCue.file,
          cue: glyph.firstCue.index,
        },
        affectedLines: glyph.affectedCues.map((cue) => ({
          file: cue.file,
          cue: cue.index,
          timestamp: formatTimestamp(cue.start),
          text: cue.text,
        })),
      })),
    },
    null,
    2,
  );
}
