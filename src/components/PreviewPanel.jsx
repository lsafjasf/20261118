import { useEffect, useMemo, useState } from "react";
import {
  Pause,
  Play,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Type,
} from "lucide-react";
import { formatTimestamp, getSubtitleDuration } from "../lib/subtitles";
import { segmentByCoverage, unicodeLabel } from "../lib/glyphs";
import InlineCueText from "./InlineCueText";

function PreviewLine({ text, font }) {
  return (
    <>
      {segmentByCoverage(text, font).map((segment, index) => {
        if (segment.kind !== "missing") {
          return <span key={`${index}-${segment.text}`}>{segment.text}</span>;
        }
        return Array.from(segment.text).map((char, charIndex) => (
          <span
            className="preview-missing"
            key={`${index}-${charIndex}-${char}`}
            title={`${char} · ${unicodeLabel(char)}`}
          >
            {unicodeLabel(char)}
          </span>
        ));
      })}
    </>
  );
}

export default function PreviewPanel({
  cues,
  currentTime,
  onTimeChange,
  font,
  fontFamily,
  missingCodes,
  onOpenCandidates,
}) {
  const [playing, setPlaying] = useState(false);
  const duration = useMemo(() => Math.max(getSubtitleDuration(cues), 1), [cues]);
  const activeCue = cues.find(
    (cue) => currentTime >= cue.start && currentTime < cue.end,
  );

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      onTimeChange((value) => {
        if (value >= duration) {
          setPlaying(false);
          return duration;
        }
        return Math.min(duration, value + 0.1);
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, duration, onTimeChange]);

  return (
    <aside className="preview-panel">
      <div className="preview-heading">
        <div>
          <span className="section-kicker">LIVE PREVIEW</span>
          <h2>字幕预览</h2>
        </div>
        <span className={`preview-policy ${activeCue ? "" : "is-idle"}`}>
          <ShieldAlert size={13} />
          无回退
        </span>
      </div>

      <div className="monitor">
        <div className="monitor-scene">
          <span className="scene-orb scene-orb-one" />
          <span className="scene-orb scene-orb-two" />
          <span className="scene-horizon" />
        </div>
        <div className="monitor-top">
          <span className="monitor-rec">
            <i />
            PREVIEW
          </span>
          <span className="monitor-time">
            {formatTimestamp(currentTime).slice(3, 8)} /{" "}
            {formatTimestamp(duration).slice(3, 8)}
          </span>
        </div>
        <div
          className="monitor-caption"
          style={fontFamily ? { fontFamily: `"${fontFamily}"` } : undefined}
        >
          {activeCue ? (
            <PreviewLine text={activeCue.text} font={font} />
          ) : (
            <span className="empty-caption">当前时间没有字幕</span>
          )}
        </div>
        <div className="monitor-footer">
          <span>{activeCue ? `#${String(activeCue.index).padStart(2, "0")}` : "—"}</span>
          <span>{font?.familyName || font?.postscriptName || ""}</span>
        </div>
      </div>

      <div className="transport">
        <button
          type="button"
          className="play-button"
          aria-label={playing ? "暂停预览" : "播放预览"}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
        </button>
        <input
          className="time-range"
          type="range"
          min="0"
          max={duration}
          step="0.01"
          value={Math.min(currentTime, duration)}
          onChange={(event) => onTimeChange(Number(event.target.value))}
          style={{
            "--range-progress": `${(Math.min(currentTime, duration) / duration) * 100}%`,
          }}
          aria-label="字幕时间轴"
        />
        <span className="transport-time">{formatTimestamp(currentTime)}</span>
      </div>

      <div className="cue-section">
        <div className="cue-section-head">
          <span>字幕时间线</span>
          <span>{cues.length} 条</span>
        </div>
        <div className="cue-list">
          {cues.map((cue) => {
            const active = cue.id === activeCue?.id;
            const hasMissing = Array.from(cue.text).some(
              (char) => missingCodes.has(char.codePointAt(0)) && !/\s/u.test(char),
            );
            return (
              <button
                type="button"
                key={`${cue.file}-${cue.id}`}
                className={`cue-item ${active ? "is-active" : ""} ${hasMissing ? "has-missing" : ""}`}
                onClick={() => onTimeChange(cue.start + 0.05)}
              >
                <span className="cue-time">{formatTimestamp(cue.start).slice(3)}</span>
                <span className="cue-marker" />
                <span className="cue-text">
                  <InlineCueText text={cue.text} font={font} />
                </span>
                {hasMissing && <span className="cue-gap-dot" title="包含缺字" />}
              </button>
            );
          })}
        </div>
      </div>

      <button type="button" className="replacement-teaser" onClick={onOpenCandidates}>
        <span className="teaser-icon">
          <Sparkles size={17} />
        </span>
        <span className="teaser-copy">
          <strong>需要更完整的字体？</strong>
          <span>按当前字幕字符集核对候选字体</span>
        </span>
        <span className="teaser-arrow">查看</span>
      </button>

      <div className="preview-hint">
        <Type size={14} />
        <span>预览不会调用系统字体补齐缺字</span>
        <ShieldCheck size={14} />
      </div>
    </aside>
  );
}
