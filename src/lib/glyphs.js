export const LANGUAGES = {
  chinese: { label: "中文", className: "lang-zh", color: "#f5b76c" },
  latin: { label: "英语 / 拉丁语", className: "lang-latin", color: "#8cb8ff" },
  greek: { label: "希腊语", className: "lang-greek", color: "#7ee0c2" },
  punctuation: { label: "标点", className: "lang-punct", color: "#d2a6ff" },
  number: { label: "数字", className: "lang-number", color: "#9ba8c7" },
  symbol: { label: "符号", className: "lang-symbol", color: "#ff9f8a" },
  other: { label: "其他文字", className: "lang-other", color: "#aab3c7" },
};

const HAN =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\u{20000}-\u{2fa1f}]/u;
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/u;
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const CYRILLIC = /[\u0400-\u052f]/u;
const ARABIC = /[\u0600-\u06ff\u0750-\u077f]/u;
const EMOJI = /[\u{1f000}-\u{1faff}]/u;

function isCjkPunctuation(code) {
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xfe10 && code <= 0xfe1f) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function isAsciiPunctuation(code) {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function isGeneralPunctuation(code) {
  return (
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x2e00 && code <= 0x2e7f) ||
    code === 0x00a0 ||
    code === 0x00b7
  );
}

function isSymbol(code) {
  return (
    (code >= 0x20a0 && code <= 0x20cf) ||
    (code >= 0x2100 && code <= 0x214f) ||
    (code >= 0x2190 && code <= 0x23ff) ||
    (code >= 0x2500 && code <= 0x25ff) ||
    (code >= 0x2660 && code <= 0x266f) ||
    (code >= 0x2700 && code <= 0x27bf)
  );
}

function isLatinLetter(code) {
  return (
    (code >= 0x0041 && code <= 0x005a) ||
    (code >= 0x0061 && code <= 0x007a) ||
    (code >= 0x00c0 && code <= 0x024f) ||
    (code >= 0x1e00 && code <= 0x1eff)
  );
}

export function getLanguage(char) {
  const code = char.codePointAt(0);
  if (HAN.test(char)) return LANGUAGES.chinese;
  if (GREEK.test(char)) return LANGUAGES.greek;
  if (isCjkPunctuation(code)) return LANGUAGES.punctuation;
  if (isGeneralPunctuation(code)) return LANGUAGES.punctuation;
  if (isAsciiPunctuation(code)) return LANGUAGES.punctuation;
  if (KANA.test(char)) return { ...LANGUAGES.other, label: "日语" };
  if (HANGUL.test(char)) return { ...LANGUAGES.other, label: "韩语" };
  if (CYRILLIC.test(char)) return { ...LANGUAGES.other, label: "西里尔语" };
  if (ARABIC.test(char)) return { ...LANGUAGES.other, label: "阿拉伯语" };
  if (EMOJI.test(char)) return { ...LANGUAGES.symbol, label: "表情符号" };
  if (isSymbol(code)) return LANGUAGES.symbol;
  if (isLatinLetter(code)) return LANGUAGES.latin;
  if (code >= 0x30 && code <= 0x39) return LANGUAGES.number;
  return LANGUAGES.other;
}

export function isInvisibleCharacter(char) {
  const code = char.codePointAt(0);
  return (
    /\s/u.test(char) ||
    (code >= 0 && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0xfe0e ||
    code === 0xfe0f ||
    code === 0xfeff
  );
}

export function unicodeLabel(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

export function scanGlyphs(cues) {
  const glyphMap = new Map();

  for (const cue of cues) {
    const seenInCue = new Set();
    const textLines = cue.text.split("\n");
    for (const line of textLines) {
      for (const char of Array.from(line)) {
        if (isInvisibleCharacter(char)) continue;
        const code = char.codePointAt(0);
        let glyph = glyphMap.get(code);
        if (!glyph) {
          glyph = {
            code,
            char,
            unicode: unicodeLabel(char),
            language: getLanguage(char),
            firstCue: cue,
            occurrences: 0,
            affectedCues: [],
          };
          glyphMap.set(code, glyph);
        }
        glyph.occurrences += 1;
        if (!seenInCue.has(code)) {
          seenInCue.add(code);
          glyph.affectedCues.push(cue);
        }
      }
    }
  }

  return Array.from(glyphMap.values()).sort(
    (a, b) => a.firstCue.start - b.firstCue.start || a.code - b.code,
  );
}

export function checkCoverage(glyphs, font) {
  return glyphs.map((glyph) => ({
    ...glyph,
    covered: Boolean(font?.hasGlyphForCodePoint?.(glyph.code)),
  }));
}

export function summarizeGlyphs(checkedGlyphs) {
  const covered = checkedGlyphs.filter((glyph) => glyph.covered);
  const missing = checkedGlyphs.filter((glyph) => !glyph.covered);
  const affectedCueIds = new Set(
    missing.flatMap((glyph) => glyph.affectedCues.map((cue) => `${cue.file}:${cue.id}`)),
  );
  const languageCounts = {};
  for (const glyph of missing) {
    languageCounts[glyph.language.label] =
      (languageCounts[glyph.language.label] ?? 0) + 1;
  }
  return {
    total: checkedGlyphs.length,
    covered: covered.length,
    missing,
    missingCount: missing.length,
    coveredCount: covered.length,
    affectedCueCount: affectedCueIds.size,
    coveragePercent: checkedGlyphs.length
      ? (covered.length / checkedGlyphs.length) * 100
      : 100,
    languageCounts,
  };
}

export function segmentByCoverage(text, font) {
  const segments = [];
  for (const char of Array.from(text)) {
    const kind = isInvisibleCharacter(char)
      ? "plain"
      : font?.hasGlyphForCodePoint?.(char.codePointAt(0))
        ? "covered"
        : "missing";
    const previous = segments.at(-1);
    if (previous?.kind === kind) {
      previous.text += char;
    } else {
      segments.push({ kind, text: char });
    }
  }
  return segments;
}

export function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
