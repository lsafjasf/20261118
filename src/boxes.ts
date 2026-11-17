import { Reader, Mp4ParseError } from "./reader";

export interface BoxHeader {
  type: string;
  /** box 起始偏移（含头部） */
  offset: number;
  /** box 总长度（含头部） */
  size: number;
  /** 头部长度：8 或 16（扩展尺寸） */
  headerSize: number;
  /** 载荷起始偏移 */
  contentOffset: number;
  /** 载荷长度 */
  contentSize: number;
}

export interface BoxIssue {
  offset: number;
  message: string;
}

const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "udta",
  "moof",
  "traf",
]);

export function isContainer(type: string): boolean {
  return CONTAINER_BOXES.has(type);
}

/**
 * 在 [pos, parentEnd) 窗口内读取一个 box 头部。
 * size == 1 表示 64 位扩展尺寸；size == 0 表示延伸到父窗口末尾。
 * 尺寸小于头部或越过父窗口边界视为损坏长度字段：记录 issue 并返回 null，
 * 调用方应停止遍历当前层级。
 */
export function readBoxHeader(
  r: Reader,
  parentEnd: number,
  issues: BoxIssue[]
): BoxHeader | null {
  const offset = r.pos;
  if (parentEnd - offset < 8) {
    if (parentEnd - offset > 0) {
      issues.push({
        offset,
        message: `trailing ${parentEnd - offset} byte(s) too small for a box header; skipped`,
      });
    }
    r.pos = parentEnd;
    return null;
  }
  const size32 = r.u32("box size");
  const type = r.fourCC("box type");
  let size: number;
  let headerSize = 8;
  if (size32 === 1) {
    if (parentEnd - offset < 16) {
      issues.push({
        offset,
        message: `box '${type}' declares extended (64-bit) size but header is truncated`,
      });
      r.pos = parentEnd;
      return null;
    }
    size = r.u64("box largesize");
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  } else {
    size = size32;
  }
  if (size < headerSize) {
    issues.push({
      offset,
      message: `box '${type}' has corrupt size ${size} (< header size ${headerSize}); stopping this level`,
    });
    r.pos = parentEnd;
    return null;
  }
  if (offset + size > parentEnd) {
    if (isContainer(type)) {
      // 容器被截断：截短到父窗口边界，尽量挽救内部仍完整的子 box
      issues.push({
        offset,
        message: `container '${type}' size ${size} overruns parent window (ends at ${parentEnd}); clamped to available data`,
      });
      size = parentEnd - offset;
      return {
        type,
        offset,
        size,
        headerSize,
        contentOffset: offset + headerSize,
        contentSize: size - headerSize,
      };
    }
    issues.push({
      offset,
      message: `box '${type}' size ${size} overruns parent window (ends at ${parentEnd}); stopping this level`,
    });
    r.pos = parentEnd;
    return null;
  }
  return {
    type,
    offset,
    size,
    headerSize,
    contentOffset: offset + headerSize,
    contentSize: size - headerSize,
  };
}

export { Mp4ParseError };
