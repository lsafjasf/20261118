import { Download, Layers3, ShieldCheck } from "lucide-react";

function GlyphMark() {
  return (
    <svg viewBox="0 0 38 38" aria-hidden="true" className="brand-mark">
      <path d="M7 3H3v4M31 3h4v4M7 35H3v-4M31 35h4v-4" />
      <path d="M12 12.5h8.5a7 7 0 0 1 0 14H12V12.5Z" />
      <path d="M12 19.5h9M21 26.5V31h8" />
    </svg>
  );
}

export default function TopBar({ missingCount, onExport, onOpenCandidates }) {
  return (
    <header className="topbar">
      <div className="brand-block">
        <GlyphMark />
        <div>
          <div className="brand-name">GLYPHLINE</div>
          <div className="brand-sub">字幕字形审查</div>
        </div>
      </div>

      <div className="topbar-project">
        <span className="project-kicker">当前项目</span>
        <span className="project-slash">/</span>
        <span className="project-name">EP03 · 字幕交付检查</span>
        <span className="project-state">草稿</span>
      </div>

      <div className="topbar-actions">
        <div className="live-status">
          <ShieldCheck size={15} />
          <span>cmap 实时比对</span>
        </div>
        <button className="button button-ghost" onClick={onOpenCandidates}>
          <Layers3 size={16} />
          <span>候选字体</span>
        </button>
        <button className="button button-accent" onClick={onExport}>
          <Download size={16} />
          <span>导出缺字报告</span>
          {missingCount > 0 && <span className="button-count">{missingCount}</span>}
        </button>
      </div>
    </header>
  );
}
