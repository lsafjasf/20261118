import { segmentByCoverage } from "../lib/glyphs";

export default function InlineCueText({ text, font, className = "" }) {
  const segments = segmentByCoverage(text, font);
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.kind === "missing" ? (
          <mark className="inline-missing" key={`${index}-${segment.text}`}>
            {segment.text}
          </mark>
        ) : (
          <span key={`${index}-${segment.text}`}>{segment.text}</span>
        ),
      )}
    </span>
  );
}
