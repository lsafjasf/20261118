import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, TriangleAlert, X } from "lucide-react";
import demoSource from "./data/demo.srt?raw";
import TopBar from "./components/TopBar";
import SourceRail from "./components/SourceRail";
import FontPicker from "./components/FontPicker";
import MetricCards from "./components/MetricCards";
import MissingTable from "./components/MissingTable";
import PreviewPanel from "./components/PreviewPanel";
import CandidateDrawer from "./components/CandidateDrawer";
import {
  BUILTIN_FONTS,
  DEFAULT_FONT,
  createCustomFontDescriptor,
  inspectFont,
  loadFont,
  registerPreviewFace,
} from "./lib/fonts";
import {
  checkCoverage,
  scanGlyphs,
  summarizeGlyphs,
} from "./lib/glyphs";
import { parseSubtitle } from "./lib/subtitles";
import {
  buildCandidateCsv,
  buildMissingReportCsv,
  downloadText,
} from "./lib/exporters";

const DEMO_FILE_NAME = "demo_episode_03.srt";

function createDemoFile() {
  return {
    id: "demo-file",
    name: DEMO_FILE_NAME,
    demo: true,
    parsed: parseSubtitle(demoSource, DEMO_FILE_NAME),
  };
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.type || "success"}`} role="status">
      <span className="toast-icon">
        {toast.type === "error" ? (
          <TriangleAlert size={17} />
        ) : (
          <CheckCircle2 size={17} />
        )}
      </span>
      <span>{toast.message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示">
        <X size={14} />
      </button>
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState(() => [createDemoFile()]);
  const [activeFileId, setActiveFileId] = useState("demo-file");
  const [selectedFont, setSelectedFont] = useState(DEFAULT_FONT);
  const [availableFonts, setAvailableFonts] = useState(BUILTIN_FONTS);
  const [font, setFont] = useState(null);
  const [fontFamily, setFontFamily] = useState(null);
  const [fontLoading, setFontLoading] = useState(true);
  const [fontError, setFontError] = useState("");
  const [currentTime, setCurrentTime] = useState(44.1);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [toast, setToast] = useState(null);

  const allCues = useMemo(
    () =>
      files
        .flatMap((file) => file.parsed.cues)
        .sort((a, b) => a.start - b.start || a.end - b.end),
    [files],
  );
  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0];
  const previewCues = activeFile?.parsed.cues ?? [];
  const glyphs = useMemo(() => scanGlyphs(allCues), [allCues]);
  const checkedGlyphs = useMemo(() => checkCoverage(glyphs, font), [glyphs, font]);
  const summary = useMemo(() => summarizeGlyphs(checkedGlyphs), [checkedGlyphs]);
  const missingCodes = useMemo(
    () => new Set(summary.missing.map((glyph) => glyph.code)),
    [summary.missing],
  );

  const candidateDescriptors = useMemo(
    () => Array.from(new Map(availableFonts.map((item) => [item.id, item])).values()),
    [availableFonts],
  );

  const showToast = (message, type = "success") => {
    setToast({ message, type, id: Date.now() });
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    setFontLoading(true);
    setFontError("");
    Promise.all([
      loadFont(selectedFont).then(({ font: loaded }) => loaded),
      registerPreviewFace(selectedFont),
    ])
      .then(([loadedFont, family]) => {
        if (cancelled) return;
        setFont(loadedFont);
        setFontFamily(family);
        setFontLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setFont(null);
        setFontFamily(null);
        setFontError(error instanceof Error ? error.message : "字体解析失败");
        setFontLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFont]);

  useEffect(() => {
    if (!candidateOpen) return undefined;
    let cancelled = false;
    setCandidatesLoading(true);
    Promise.all(
      candidateDescriptors.map((descriptor) =>
        inspectFont(descriptor, glyphs).catch((error) => ({
          descriptor,
          font: null,
          missing: glyphs,
          missingCount: glyphs.length,
          coveredCount: 0,
          coveragePercent: 0,
          glyphCount: 0,
          error: error instanceof Error ? error.message : "解析失败",
        })),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        setCandidates(results);
        setCandidatesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCandidates([]);
        setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateOpen, candidateDescriptors, glyphs]);

  async function handleSubtitleFiles(fileList) {
    const incoming = Array.from(fileList ?? []);
    if (!incoming.length) return;
    const parsedFiles = [];
    for (const item of incoming) {
      try {
        const text = await item.text();
        const parsed = parseSubtitle(text, item.name);
        if (!parsed.cues.length) throw new Error("没有识别到字幕条目");
        parsedFiles.push({
          id: `${item.name}-${item.size}-${item.lastModified}`,
          name: item.name,
          demo: false,
          parsed,
        });
      } catch (error) {
        showToast(`${item.name}：${error.message}`, "error");
      }
    }
    if (!parsedFiles.length) return;
    setFiles((previous) => {
      const base = previous.length === 1 && previous[0].demo ? [] : previous;
      return [...base, ...parsedFiles];
    });
    setActiveFileId(parsedFiles[0].id);
    setCurrentTime(parsedFiles[0].parsed.cues[0]?.start + 0.05 || 0);
    showToast(`已扫描 ${parsedFiles.length} 个字幕文件`);
  }

  async function handleFontUpload(file) {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const descriptor = createCustomFontDescriptor(file, buffer);
      await loadFont(descriptor);
      setAvailableFonts((previous) => [
        descriptor,
        ...previous.filter((item) => item.id !== descriptor.id),
      ]);
      setSelectedFont(descriptor);
      showToast(`已导入并审查 ${descriptor.name}`);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "无法解析该字体文件",
        "error",
      );
    }
  }

  function removeFile(fileId) {
    setFiles((previous) => {
      const next = previous.filter((item) => item.id !== fileId);
      if (fileId === activeFileId) {
        setActiveFileId(next[0]?.id ?? null);
        setCurrentTime(next[0]?.parsed.cues[0]?.start + 0.05 || 0);
      }
      return next;
    });
  }

  function selectCue(cue) {
    const file = files.find((item) => item.name === cue.file);
    if (file) setActiveFileId(file.id);
    setCurrentTime(cue.start + 0.05);
  }

  function exportReport() {
    const content = buildMissingReportCsv(summary, selectedFont);
    downloadText("subtitle-glyph-report.csv", content, "text/csv;charset=utf-8");
    showToast(`缺字报告已导出 · ${summary.missingCount} 个字符`);
  }

  function exportCandidates() {
    const content = buildCandidateCsv(candidates);
    downloadText(
      "font-replacement-candidates.csv",
      content,
      "text/csv;charset=utf-8",
    );
    showToast(`候选字体清单已导出 · ${candidates.length} 个字体`);
  }

  return (
    <div className="app-shell">
      <TopBar
        missingCount={summary.missingCount}
        onExport={exportReport}
        onOpenCandidates={() => setCandidateOpen(true)}
      />

      <div className="workbench">
        <SourceRail
          files={files}
          activeFileId={activeFile?.id}
          checkedGlyphs={checkedGlyphs}
          onFiles={handleSubtitleFiles}
          onSelectFile={setActiveFileId}
          onRemoveFile={removeFile}
        />

        <main className="audit-main">
          <div className="main-heading">
            <div>
              <span className="section-kicker">AUDIT / GLYPH COVERAGE</span>
              <h1>字形覆盖报告</h1>
              <p>
                逐字符核对字幕与字体 cmap，定位缺字、语言及首次出现位置。
              </p>
            </div>
            <div className={`audit-state ${summary.missingCount ? "has-gaps" : "is-clear"}`}>
              <span className="audit-state-dot" />
              {fontLoading
                ? "正在重新比对"
                : summary.missingCount
                  ? `${summary.missingCount} 个缺字待处理`
                  : "全部字符已覆盖"}
            </div>
          </div>

          <FontPicker
            font={selectedFont}
            fonts={availableFonts}
            loading={fontLoading}
            error={fontError}
            onChange={setSelectedFont}
            onUpload={handleFontUpload}
            onOpenCandidates={() => setCandidateOpen(true)}
          />

          {fontLoading && !font && (
            <div className="audit-skeleton">
              <span />
              <span />
              <span />
            </div>
          )}

          <MetricCards
            summary={summary}
            cueCount={allCues.length}
            fileCount={files.length}
          />

          <MissingTable
            summary={summary}
            font={font}
            onSelectCue={selectCue}
            onOpenCandidates={() => setCandidateOpen(true)}
          />

          <footer className="main-footer">
            <span>GLYPHLINE · SUBTITLE QA</span>
            <span>扫描结果仅依据字体文件内的真实字形表</span>
          </footer>
        </main>

        <PreviewPanel
          cues={previewCues}
          currentTime={currentTime}
          onTimeChange={setCurrentTime}
          font={font}
          fontFamily={fontFamily}
          missingCodes={missingCodes}
          onOpenCandidates={() => setCandidateOpen(true)}
        />
      </div>

      <CandidateDrawer
        open={candidateOpen}
        loading={candidatesLoading}
        candidates={candidates}
        currentFont={selectedFont}
        glyphCount={glyphs.length}
        onApply={(descriptor) => {
          setSelectedFont(descriptor);
          setCandidateOpen(false);
          showToast(`已切换至 ${descriptor.name}，报告已重算`);
        }}
        onExport={exportCandidates}
        onClose={() => setCandidateOpen(false)}
      />

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
