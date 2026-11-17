import { useEffect } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";

function CandidateCard({ candidate, current, onApply }) {
  const { descriptor, missingCount, coveragePercent, coveredCount, glyphCount } =
    candidate;
  const complete = missingCount === 0;
  const isCurrent = descriptor.id === current.id;

  return (
    <article className={`candidate-card ${complete ? "is-complete" : ""}`}>
      <div className="candidate-top">
        <div className="candidate-font-mark">Aa</div>
        <div className="candidate-copy">
          <div className="candidate-name-line">
            <strong>{descriptor.name}</strong>
            {complete && (
              <span className="complete-badge">
                <Check size={11} />
                完整覆盖
              </span>
            )}
            {!complete && (
              <span className="partial-badge">
                <TriangleAlert size={11} />缺 {missingCount}
              </span>
            )}
          </div>
          <span className="candidate-meta">
            {descriptor.style} · {descriptor.format} · {glyphCount.toLocaleString()} glyphs
          </span>
        </div>
      </div>

      <div className="candidate-coverage">
        <div className="candidate-coverage-head">
          <span>当前字幕字符覆盖</span>
          <strong>{coveragePercent.toFixed(1)}%</strong>
        </div>
        <div className="candidate-track">
          <span
            className={complete ? "is-complete" : ""}
            style={{ width: `${coveragePercent}%` }}
          />
        </div>
        <span className="candidate-count">
          覆盖 {coveredCount} / {coveredCount + missingCount} 个唯一字符
        </span>
      </div>

      {!complete && (
        <div className="remaining-glyphs">
          {candidate.missing.slice(0, 7).map((glyph) => (
            <span key={glyph.code} title={glyph.char}>
              {glyph.unicode}
            </span>
          ))}
          {candidate.missing.length > 7 && (
            <span>+{candidate.missing.length - 7}</span>
          )}
        </div>
      )}

      <div className="candidate-footer">
        <span>{descriptor.license}</span>
        <button
          type="button"
          className={`apply-font ${isCurrent ? "is-current" : ""}`}
          onClick={() => onApply(descriptor)}
          disabled={isCurrent}
        >
          {isCurrent ? "正在使用" : "用于审查"}
        </button>
      </div>
    </article>
  );
}

export default function CandidateDrawer({
  open,
  loading,
  candidates,
  currentFont,
  glyphCount,
  onApply,
  onExport,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);

  if (!open) return null;

  const sorted = [...candidates].sort(
    (a, b) => b.coveredCount - a.coveredCount || a.descriptor.name.localeCompare(b.descriptor.name),
  );
  const completeCount = sorted.filter((item) => item.missingCount === 0).length;

  return (
    <div className="drawer-layer" role="presentation">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="关闭候选字体"
        onClick={onClose}
      />
      <aside
        className="candidate-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="candidate-title"
      >
        <div className="drawer-head">
          <div>
            <span className="section-kicker">FONT REPLACEMENT</span>
            <h2 id="candidate-title">替换字体候选</h2>
            <p>
              基于当前 {glyphCount} 个唯一字符，实时读取每个字体的真实 cmap。
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="drawer-summary">
          <div>
            <ShieldCheck size={18} />
            <span>
              <strong>{completeCount}</strong> 个字体可完整覆盖当前字幕
            </span>
          </div>
          <span>缺字数为 0 才会标记为可替换</span>
        </div>

        <div className="candidate-list">
          {loading && (
            <div className="candidate-loading">
              <LoaderCircle size={24} className="spin" />
              <strong>正在核对候选字体</strong>
              <span>读取字体文件与 cmap 表，请稍候…</span>
            </div>
          )}
          {!loading &&
            sorted.map((candidate) => (
              <CandidateCard
                key={candidate.descriptor.id}
                candidate={candidate}
                current={currentFont}
                onApply={onApply}
              />
            ))}
          {!loading && sorted.length === 0 && (
            <div className="candidate-loading">
              <TriangleAlert size={24} />
              <strong>没有可用候选字体</strong>
              <span>请导入一份字体文件后重试。</span>
            </div>
          )}
        </div>

        <div className="drawer-footer">
          <p>
            清单仅包含实测覆盖结果。部分覆盖字体仍会保留剩余缺字，不会自动借用其他字体。
          </p>
          <button
            type="button"
            className="button button-accent export-candidates"
            onClick={onExport}
            disabled={loading || sorted.length === 0}
          >
            <Download size={16} />
            导出候选清单 CSV
          </button>
        </div>
      </aside>
    </div>
  );
}
