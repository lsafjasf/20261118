import { useState } from "react";
import {
  FileText,
  ScanLine,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { formatDuration, getSubtitleDuration } from "../lib/subtitles";

function FileCard({ file, active, onSelect, onRemove }) {
  return (
    <button
      className={`source-file ${active ? "is-active" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="file-icon">
        <FileText size={17} />
      </span>
      <span className="file-copy">
        <span className="file-name">{file.name}</span>
        <span className="file-meta">
          {file.parsed.format} · {file.parsed.cues.length} 条 ·{" "}
          {formatDuration(getSubtitleDuration(file.parsed.cues))}
        </span>
      </span>
      <span
        className="file-remove"
        role="button"
        tabIndex={0}
        aria-label={`移除 ${file.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(file.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") onRemove(file.id);
        }}
      >
        <Trash2 size={14} />
      </span>
    </button>
  );
}

function DropZone({ onFiles }) {
  const [dragging, setDragging] = useState(false);

  return (
    <label
      className={`drop-zone ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onFiles(event.dataTransfer.files);
      }}
    >
      <input
        type="file"
        multiple
        accept=".srt,.vtt,.ass,.ssa,text/plain"
        onChange={(event) => onFiles(event.target.files)}
      />
      <UploadCloud size={20} />
      <span className="drop-title">拖入字幕文件</span>
      <span className="drop-meta">SRT · VTT · ASS · 可多选</span>
    </label>
  );
}

function LanguageRows({ checkedGlyphs }) {
  const groups = new Map();
  for (const glyph of checkedGlyphs) {
    const key = glyph.language.label;
    const group = groups.get(key) ?? { label: key, total: 0, missing: 0 };
    group.total += 1;
    if (!glyph.covered) group.missing += 1;
    groups.set(key, group);
  }
  const rows = Array.from(groups.values())
    .sort((a, b) => b.missing - a.missing || b.total - a.total)
    .slice(0, 5);

  return (
    <div className="language-list">
      {rows.map((row) => (
        <div className="language-row" key={row.label}>
          <div className="language-line">
            <span>{row.label}</span>
            <span className={row.missing ? "tone-danger" : "tone-muted"}>
              {row.missing ? `${row.missing} 缺字` : `${row.total} 已覆盖`}
            </span>
          </div>
          <div className="mini-track">
            <span
              className={row.missing ? "is-danger" : "is-ok"}
              style={{
                width: `${((row.total - row.missing) / row.total) * 100}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SourceRail({
  files,
  activeFileId,
  checkedGlyphs,
  onFiles,
  onSelectFile,
  onRemoveFile,
}) {
  return (
    <aside className="source-rail">
      <div className="rail-heading">
        <div>
          <span className="section-kicker">SOURCE</span>
          <h2>字幕源</h2>
        </div>
        <span className="count-badge">{files.length}</span>
      </div>

      <div className="source-list">
        {files.map((file) => (
          <FileCard
            key={file.id}
            file={file}
            active={file.id === activeFileId}
            onSelect={() => onSelectFile(file.id)}
            onRemove={() => onRemoveFile(file.id)}
          />
        ))}
        <DropZone onFiles={onFiles} />
      </div>

      <div className="rail-section">
        <div className="rail-section-title">
          <ScanLine size={15} />
          <span>扫描范围</span>
        </div>
        <p className="rail-note">
          按 Unicode 码点扫描全部可见字符，并逐字读取所选字体的 cmap。
        </p>
        <LanguageRows checkedGlyphs={checkedGlyphs} />
      </div>

      <div className="policy-card">
        <div className="policy-icon">
          <ShieldCheck size={17} />
        </div>
        <div>
          <strong>禁止隐式回退</strong>
          <p>预览只使用所选字体；无字形字符显示为明确的 Unicode 缺字标记。</p>
        </div>
      </div>

      <div className="rail-footer">
        <span className="status-dot" />
        <span>检测引擎 2.4</span>
        <span>·</span>
        <span>Unicode 15.1</span>
      </div>
    </aside>
  );
}
