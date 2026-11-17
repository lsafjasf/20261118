import { Clock3, PieChart, ScanText, TriangleAlert } from "lucide-react";
import { formatTimestamp } from "../lib/subtitles";

export default function MetricCards({ summary, cueCount, fileCount }) {
  const firstMissing = summary.missing[0];
  const coverage = summary.coveragePercent;

  return (
    <section className="metrics" aria-label="字形覆盖摘要">
      <article className="metric-card metric-neutral">
        <div className="metric-icon">
          <ScanText size={17} />
        </div>
        <span className="metric-label">扫描字符</span>
        <strong className="metric-value">{summary.total}</strong>
        <span className="metric-foot">
          {fileCount} 个文件 · {cueCount} 条字幕
        </span>
      </article>

      <article className="metric-card metric-danger">
        <div className="metric-icon">
          <TriangleAlert size={17} />
        </div>
        <span className="metric-label">缺失字形</span>
        <strong className="metric-value">{summary.missingCount}</strong>
        <span className="metric-foot">
          涉及 {summary.affectedCueCount} 条字幕行
        </span>
      </article>

      <article className="metric-card metric-good">
        <div className="metric-icon">
          <PieChart size={17} />
        </div>
        <span className="metric-label">字形覆盖率</span>
        <strong className="metric-value">{coverage.toFixed(1)}%</strong>
        <div className="coverage-track">
          <span style={{ width: `${coverage}%` }} />
        </div>
      </article>

      <article className="metric-card metric-neutral">
        <div className="metric-icon">
          <Clock3 size={17} />
        </div>
        <span className="metric-label">首次缺字</span>
        <strong className="metric-time">
          {firstMissing ? formatTimestamp(firstMissing.firstCue.start) : "—"}
        </strong>
        <span className="metric-foot">
          {firstMissing
            ? `${firstMissing.language.label} · ${firstMissing.unicode}`
            : "当前字体完整覆盖"}
        </span>
      </article>
    </section>
  );
}
