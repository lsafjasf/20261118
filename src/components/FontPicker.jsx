import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Layers3,
  LoaderCircle,
  Upload,
} from "lucide-react";

export default function FontPicker({
  font,
  fonts,
  loading,
  error,
  onChange,
  onUpload,
  onOpenCandidates,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const uploadRef = useRef(null);

  useEffect(() => {
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className="font-picker" ref={rootRef}>
      <div className="font-picker-main">
        <div className="font-avatar">Aa</div>
        <div className="font-copy">
          <span className="font-label">审查字体</span>
          <div className="font-title-line">
            <strong>{font.name}</strong>
            <span className="font-style">{font.style}</span>
            {loading && <LoaderCircle size={14} className="spin" />}
          </div>
          <span className="font-file">
            {font.fileName} · {font.format} · {font.license}
          </span>
          {error && <span className="font-error">{error}</span>}
        </div>
        <button
          type="button"
          className="font-replace"
          onClick={() => setOpen((value) => !value)}
        >
          <span>更换字体</span>
          <ChevronDown size={15} className={open ? "rotate-180" : ""} />
        </button>
      </div>

      {open && (
        <div className="font-menu">
          <div className="font-menu-head">
            <span>选择审查字体</span>
            <span>切换后立即重算</span>
          </div>
          <div className="font-menu-list">
            {fonts.map((item) => (
              <button
                type="button"
                className={`font-option ${item.id === font.id ? "is-selected" : ""}`}
                key={item.id}
                onClick={() => {
                  onChange(item);
                  setOpen(false);
                }}
              >
                <span className="option-preview">Aa</span>
                <span className="option-copy">
                  <span className="option-name">
                    {item.name}
                    {item.builtin === false && <em>导入</em>}
                  </span>
                  <span className="option-note">
                    {item.style} · {item.note}
                  </span>
                </span>
                {item.id === font.id && <Check size={16} />}
              </button>
            ))}
          </div>
          <div className="font-menu-actions">
            <button
              type="button"
              className="menu-action"
              onClick={() => uploadRef.current?.click()}
            >
              <Upload size={15} />
              导入字体文件
            </button>
            <button
              type="button"
              className="menu-action"
              onClick={() => {
                setOpen(false);
                onOpenCandidates();
              }}
            >
              <Layers3 size={15} />
              候选清单
            </button>
          </div>
          <input
            ref={uploadRef}
            className="visually-hidden"
            type="file"
            accept=".ttf,.otf,.woff,.woff2"
            onChange={(event) => {
              onUpload(event.target.files?.[0]);
              setOpen(false);
              event.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
