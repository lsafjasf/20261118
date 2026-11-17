const TIMESTAMP = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

export function parseTimestamp(value) {
  const match = String(value).trim().match(TIMESTAMP);
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction) / 10 ** fraction.length
  );
}

export function formatTimestamp(totalSeconds, separator = ",") {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const milliseconds = Math.round(safe * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
    .concat(separator, String(millis).padStart(3, "0"));
}

export function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function cleanSubtitleText(value) {
  return decodeEntities(
    String(value)
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\h/g, " ")
      .replace(/\{[^}]*\}/g, "")
      .replace(/<[^>]*>/g, ""),
  ).trim();
}

function normalize(value) {
  return String(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function detectFormat(text, fileName = "") {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension && ["srt", "vtt", "ass", "ssa"].includes(extension)) {
    return extension === "ssa" ? "ass" : extension;
  }
  if (/^WEBVTT\b/i.test(text)) return "vtt";
  if (/^\s*\[Script Info\]/im.test(text)) return "ass";
  return "srt";
}

function parseCueBlock(block, index) {
  const lines = block.split("\n");
  const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
  if (timeLineIndex === -1) return null;

  const [startRaw, endRaw] = lines[timeLineIndex].split("-->");
  const endMatch = endRaw?.trim().match(/^\S+/);
  const start = parseTimestamp(startRaw);
  const end = parseTimestamp(endMatch?.[0] ?? "");
  if (start == null || end == null) return null;

  const text = cleanSubtitleText(lines.slice(timeLineIndex + 1).join("\n"));
  if (!text) return null;

  const label = lines.slice(0, timeLineIndex).join(" ").trim();
  return {
    id: `cue-${index + 1}`,
    index: index + 1,
    label: label || String(index + 1),
    start,
    end,
    text,
  };
}

function parseTimedText(text) {
  const blocks = normalize(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(block));
  return blocks.map(parseCueBlock).filter(Boolean);
}

function splitFields(value, count) {
  const fields = [];
  let rest = value;
  for (let index = 0; index < count - 1; index += 1) {
    const comma = rest.indexOf(",");
    if (comma === -1) break;
    fields.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  fields.push(rest);
  return fields;
}

function parseAss(text) {
  const normalized = normalize(text);
  const eventsIndex = normalized.search(/^\[Events\]\s*$/im);
  if (eventsIndex === -1) return [];
  const events = normalized.slice(eventsIndex);
  const formatMatch = events.match(/^Format:\s*(.+)$/im);
  const format = formatMatch
    ? formatMatch[1].split(",").map((item) => item.trim().toLowerCase())
    : [
        "layer",
        "start",
        "end",
        "style",
        "name",
        "marginl",
        "marginr",
        "marginv",
        "effect",
        "text",
      ];

  return events
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^Dialogue:/i.test(line))
    .map((line, index) => {
      const fields = splitFields(line.replace(/^Dialogue:\s*/i, ""), format.length);
      const record = Object.fromEntries(format.map((key, fieldIndex) => [key, fields[fieldIndex] ?? ""]));
      const start = parseTimestamp(record.start);
      const end = parseTimestamp(record.end);
      const cueText = cleanSubtitleText(record.text);
      if (start == null || end == null || !cueText) return null;
      return {
        id: `cue-${index + 1}`,
        index: index + 1,
        label: record.name || String(index + 1),
        start,
        end,
        text: cueText,
      };
    })
    .filter(Boolean);
}

export function parseSubtitle(text, fileName = "subtitle.srt") {
  const format = detectFormat(text, fileName);
  const cues = format === "ass" ? parseAss(text) : parseTimedText(text);
  return {
    file: fileName,
    format: format.toUpperCase(),
    cues: cues
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map((cue, index) => ({ ...cue, index: index + 1, file: fileName })),
  };
}

export function getSubtitleDuration(cues) {
  return cues.reduce((latest, cue) => Math.max(latest, cue.end), 0);
}
