import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { create } from "fontkit";
import { describe, expect, it } from "vitest";
import demoSource from "../data/demo.srt?raw";
import { parseSubtitle, parseTimestamp } from "./subtitles";
import {
  checkCoverage,
  getLanguage,
  scanGlyphs,
  segmentByCoverage,
  summarizeGlyphs,
} from "./glyphs";
import { buildCandidateCsv, buildMissingReportCsv } from "./exporters";

const fontPath = (name) =>
  fileURLToPath(new URL(`../../public/fonts/${name}`, import.meta.url));

function openFont(name) {
  return create(readFileSync(fontPath(name)));
}

describe("subtitle parsing", () => {
  it("parses SRT timecodes, tags and multiline cues", () => {
    const parsed = parseSubtitle(
      `\uFEFF1\r
00:00:01,250 --> 00:00:04,500\r
<i>你好</i> world\r
second line\r
\r
2\r
00:00:05,000 --> 00:00:07,000\r
Greek: Ω\r
`,
      "sample.srt",
    );
    expect(parsed.format).toBe("SRT");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0].start).toBeCloseTo(1.25);
    expect(parsed.cues[0].text).toBe("你好 world\nsecond line");
    expect(parsed.cues[1].start).toBe(5);
  });

  it("parses WebVTT cue settings and tags", () => {
    const parsed = parseSubtitle(
      `WEBVTT

cue-one
00:01.000 --> 00:02.500 align:middle
<c.yellow>Hello</c> 世界
`,
      "sample.vtt",
    );
    expect(parsed.format).toBe("VTT");
    expect(parsed.cues[0].text).toBe("Hello 世界");
    expect(parsed.cues[0].start).toBe(1);
  });

  it("parses ASS dialogue fields including commas in text", () => {
    const parsed = parseSubtitle(
      `[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\an8}Hello, world\\N下一行
`,
      "sample.ass",
    );
    expect(parsed.format).toBe("ASS");
    expect(parsed.cues[0].text).toBe("Hello, world\n下一行");
    expect(parsed.cues[0].start).toBe(2);
  });

  it("normalizes timestamps", () => {
    expect(parseTimestamp("1:02:03.45")).toBe(3723.45);
  });
});

describe("glyph scanning and coverage", () => {
  it("classifies Chinese, English, Greek and punctuation", () => {
    expect(getLanguage("中").label).toBe("中文");
    expect(getLanguage("A").label).toBe("英语 / 拉丁语");
    expect(getLanguage("Ω").label).toBe("希腊语");
    expect(getLanguage("—").label).toBe("标点");
    expect(getLanguage("→").label).toBe("符号");
  });

  it("deduplicates code points while retaining every affected cue", () => {
    const parsed = parseSubtitle(
      `1
00:00:01,000 --> 00:00:02,000
中 A

2
00:00:03,000 --> 00:00:04,000
中 B
`,
      "dedupe.srt",
    );
    const glyphs = scanGlyphs(parsed.cues);
    const zhong = glyphs.find((glyph) => glyph.char === "中");
    expect(glyphs).toHaveLength(3);
    expect(zhong.occurrences).toBe(2);
    expect(zhong.affectedCues).toHaveLength(2);
    expect(zhong.firstCue.start).toBe(1);
  });

  it("finds real cmap gaps for the demo across mixed scripts", () => {
    const parsed = parseSubtitle(demoSource, "demo.srt");
    const glyphs = scanGlyphs(parsed.cues);

    const dejavu = openFont("DejaVuSans.ttf");
    const dejavuSummary = summarizeGlyphs(checkCoverage(glyphs, dejavu));
    expect(dejavuSummary.missingCount).toBeGreaterThan(0);
    expect(dejavuSummary.missing.some((item) => item.char === "中")).toBe(true);
    expect(dejavuSummary.missing.some((item) => item.char === "Ω")).toBe(false);
    expect(dejavuSummary.missing.some((item) => item.char === "—")).toBe(false);

    const noto = openFont("NotoSansSC.ttf");
    const notoSummary = summarizeGlyphs(checkCoverage(glyphs, noto));
    expect(notoSummary.missingCount).toBe(0);
    expect(notoSummary.coveragePercent).toBe(100);
  });

  it("marks missing characters instead of returning renderable glyphs", () => {
    const dejavu = openFont("DejaVuSans.ttf");
    const segments = segmentByCoverage("Mix 中 Ω", dejavu);
    expect(segments.some((item) => item.kind === "missing" && item.text === "中")).toBe(
      true,
    );
    expect(segments.some((item) => item.kind === "covered" && item.text.includes("Ω"))).toBe(
      true,
    );
  });

  it("exports report and candidate details as CSV", () => {
    const parsed = parseSubtitle(demoSource, "demo.srt");
    const glyphs = scanGlyphs(parsed.cues);
    const dejavu = openFont("DejaVuSans.ttf");
    const summary = summarizeGlyphs(checkCoverage(glyphs, dejavu));
    const report = buildMissingReportCsv(summary, {
      name: "DejaVu Sans",
      style: "Regular",
    });
    expect(report).toContain("U+4E2D");
    expect(report).toContain("中文");
    expect(report).toContain("可能影响的字幕行");

    const candidates = buildCandidateCsv([
      {
        descriptor: {
          name: "Noto Sans SC",
          style: "Variable",
          format: "TTF",
          license: "OFL-1.1",
          fileName: "NotoSansSC.ttf",
        },
        coveredCount: glyphs.length,
        missingCount: 0,
        coveragePercent: 100,
        missing: [],
      },
    ]);
    expect(candidates).toContain("完整覆盖");
    expect(candidates).toContain("100.00%");
  });
});
