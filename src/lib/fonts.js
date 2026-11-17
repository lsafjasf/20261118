import { create } from "fontkit";

export const BUILTIN_FONTS = [
  {
    id: "dejavu-sans",
    name: "DejaVu Sans",
    style: "Regular",
    url: "/fonts/DejaVuSans.ttf",
    fileName: "DejaVuSans.ttf",
    format: "TTF",
    license: "Bitstream Vera / Public domain",
    note: "西文与希腊字母覆盖广，无 CJK 字形",
    builtin: true,
  },
  {
    id: "ubuntu-sans",
    name: "Ubuntu Sans",
    style: "Variable",
    url: "/fonts/UbuntuSans.ttf",
    fileName: "UbuntuSans.ttf",
    format: "TTF",
    license: "Ubuntu Font Licence 1.0",
    note: "现代无衬线，适合西文与数字",
    builtin: true,
  },
  {
    id: "noto-sans-sc",
    name: "Noto Sans SC",
    style: "Variable",
    url: "/fonts/NotoSansSC.ttf",
    fileName: "NotoSansSC.ttf",
    format: "TTF",
    license: "OFL-1.1",
    note: "简体中文、拉丁与常用符号全集",
    builtin: true,
  },
  {
    id: "noto-serif-sc",
    name: "Noto Serif SC",
    style: "Variable",
    url: "/fonts/NotoSerifSC.ttf",
    fileName: "NotoSerifSC.ttf",
    format: "TTF",
    license: "OFL-1.1",
    note: "带衬线中文方案，适合对白与片名",
    builtin: true,
  },
];

export const DEFAULT_FONT = BUILTIN_FONTS[0];

const parseCache = new Map();
const faceCache = new Map();

function toBuffer(source) {
  if (source instanceof ArrayBuffer) return source;
  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  }
  return source;
}

export async function loadFont(descriptor) {
  if (parseCache.has(descriptor.id)) return parseCache.get(descriptor.id);

  const pending = (async () => {
    const buffer = descriptor.buffer
      ? toBuffer(descriptor.buffer)
      : await fetch(descriptor.url).then((response) => {
          if (!response.ok) throw new Error(`字体加载失败 (${response.status})`);
          return response.arrayBuffer();
        });
    const font = create(new Uint8Array(buffer));
    return { font, buffer };
  })();
  parseCache.set(descriptor.id, pending);
  try {
    return await pending;
  } catch (error) {
    parseCache.delete(descriptor.id);
    throw error;
  }
}

export async function registerPreviewFace(descriptor) {
  if (faceCache.has(descriptor.id)) return faceCache.get(descriptor.id);

  const pending = (async () => {
    const { buffer } = await loadFont(descriptor);
    const family = `GlyphAudit-${descriptor.id}`;
    const face = new FontFace(family, buffer.slice(0));
    await face.load();
    document.fonts.add(face);
    return family;
  })();
  faceCache.set(descriptor.id, pending);
  try {
    return await pending;
  } catch (error) {
    faceCache.delete(descriptor.id);
    throw error;
  }
}

export function createCustomFontDescriptor(file, buffer) {
  return {
    id: `custom-${file.name}-${file.size}-${file.lastModified}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    ),
    name: file.name.replace(/\.(ttf|otf|woff2?)$/i, ""),
    style: "Uploaded",
    fileName: file.name,
    format: file.name.split(".").pop()?.toUpperCase() ?? "FONT",
    license: "用户提供",
    note: "本地导入字体",
    builtin: false,
    buffer,
  };
}

export async function inspectFont(descriptor, glyphs) {
  const { font } = await loadFont(descriptor);
  const missing = glyphs.filter((glyph) => !font.hasGlyphForCodePoint(glyph.code));
  return {
    descriptor,
    font,
    missing,
    missingCount: missing.length,
    coveredCount: glyphs.length - missing.length,
    coveragePercent: glyphs.length
      ? ((glyphs.length - missing.length) / glyphs.length) * 100
      : 100,
    glyphCount: font.numGlyphs ?? font.characterSet?.length ?? 0,
  };
}
