import { useDeferredValue, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { formatTimestamp } from "../lib/subtitles";
import InlineCueText from "./InlineCueText";

function highlightMatch(text, query) {
  if (!query) return text;
  const position = text.toLowerCase().indexOf(query.toLowerCase());
  if (position === -1) return text;
  return (
    <>
      {text.slice(0, position)}
      <mark className="search-match">{text.slice(position, position + query.length)}</mark>
      {text.slice(position + query.length)}
    </>
  );
}

function CueDetails({ glyph, font, onSelectCue }) {
  return (
    <div className="cue-details">
      <div className="details-heading">
        <span>可能影响的字幕行</span>
        <span>{glyph.affectedCues.length} 条</span>
      </div>
      <div className="details-list">
        {glyph.affectedCues.map((cue) => (
          <button
            type="button"
            className="detail-cue"
            key={`${cue.file}-${cue.id}`}
            onClick={() => onSelectCue(cue)}
          >
            <span className="detail-time">{formatTimestamp(cue.start)}</span>
            <span className="detail-id">#{String(cue.index).padStart(2, "0")}</span>
            <InlineCueText text={cue.text} font={font} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MissingTable({
  summary,
  font,
  onSelectCue,
  onOpenCandidates,
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(null);
  const deferredQuery = useDeferredValue(query.trim());

  const filterOptions = useMemo(() => {
    const groups = new Map();
    for (const glyph of summary.missing) {
      groups.set(glyph.language.label, (groups.get(glyph.language.label) ?? 0) + 1);
    }
    return [
      { key: "all", label: "全部", count: summary.missingCount },
      ...Array.from(groups.entries()).map(([label, count]) => ({
        key: label,
        label,
        count,
      })),
    ];
  }, [summary.missing, summary.missingCount]);

  const rows = useMemo(() => {
    const needle = deferredQuery.toLowerCase();
    return summary.missing.filter((glyph) => {
      const matchesFilter =
        filter === "all" || glyph.language.label === filter;
      if (!matchesFilter) return false;
      if (!needle) return true;
      const haystack = [
        glyph.char,
        glyph.unicode,
        glyph.language.label,
        formatTimestamp(glyph.firstCue.start),
        ...glyph.affectedCues.map((cue) => `${cue.file} ${cue.text}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [summary.missing, filter, deferredQuery]);

  if (summary.missingCount === 0) {
    return (
      <section className="report-panel">
        <div className="report-heading">
          <div>
            <span className="section-kicker">MISSING GLYPHS</span>
            <h2>缺字清单</h2>
          </div>
        </div>
        <div className="complete-state">
          <span className="complete-icon">
            <CheckCircle2 size={28} />
          </span>
          <strong>当前字体完整覆盖全部字幕字符</strong>
          <p>没有发现缺字。更换字体后将立即重新核对。</p>
          <button type="button" className="text-link" onClick={onOpenCandidates}>
            仍然查看候选字体
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="report-panel">
      <div className="report-heading">
        <div>
          <span className="section-kicker">MISSING GLYPHS</span>
          <h2>缺字清单</h2>
          <p>按首次出现时间排序 · 点击一行查看全部受影响字幕</p>
        </div>
        <div className="table-tools">
          <div className="filter-mark">
            <SlidersHorizontal size={14} />
          </div>
          <label className="search-field">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="字符、U+码点或字幕行"
            />
          </label>
        </div>
      </div>

      <div className="filter-tabs" role="tablist" aria-label="按语言筛选">
        {filterOptions.map((option) => (
          <button
            type="button"
            role="tab"
            aria-selected={filter === option.key}
            className={filter === option.key ? "is-active" : ""}
            key={option.key}
            onClick={() => {
              setFilter(option.key);
              setExpanded(null);
            }}
          >
            {option.label}
            <span>{option.count}</span>
          </button>
        ))}
      </div>

      <div className="missing-table">
        <div className="missing-table-head">
          <span>字形</span>
          <span>Unicode</span>
          <span>语言</span>
          <span>首次出现</span>
          <span>影响</span>
          <span>字幕行预览</span>
          <span />
        </div>

        {rows.map((glyph) => {
          const isOpen = expanded === glyph.code;
          return (
            <div className={`missing-entry ${isOpen ? "is-open" : ""}`} key={glyph.code}>
              <button
                type="button"
                className="missing-row"
                onClick={() => setExpanded(isOpen ? null : glyph.code)}
              >
                <span className="glyph-report-box">
                  <span>{glyph.char}</span>
                  <small>无字形</small>
                </span>
                <span className="mono-code">
                  {highlightMatch(glyph.unicode, deferredQuery)}
                </span>
                <span className={`language-pill ${glyph.language.className}`}>
                  {glyph.language.label}
                </span>
                <span className="time-stack">
                  <strong>{formatTimestamp(glyph.firstCue.start)}</strong>
                  <small>
                    {glyph.firstCue.file} · #{String(glyph.firstCue.index).padStart(2, "0")}
                  </small>
                </span>
                <span className="impact-count">
                  {glyph.affectedCues.length}
                  <small>行</small>
                </span>
                <span className="row-preview">
                  <InlineCueText text={glyph.firstCue.text} font={font} />
                </span>
                <ChevronDown size={16} className={`row-chevron ${isOpen ? "open" : ""}`} />
              </button>
              {isOpen && (
                <CueDetails glyph={glyph} font={font} onSelectCue={onSelectCue} />
              )}
            </div>
          );
        })}

        {rows.length === 0 && (
          <div className="table-empty">
            没有匹配当前筛选条件的缺字。
          </div>
        )}
      </div>
    </section>
  );
}
