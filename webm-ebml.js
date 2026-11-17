/* webm-ebml.js — EBML/WebM 结构解析器（浏览器与 Node 通用）
 * 解析 EBML 头部、Segment、Cluster、时间码与未知长度元素，
 * 并对分片序列做结构级诊断（乱序 / 截断 / 重复 Cluster），全部给出字节偏移。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.WebmEbml = mod;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const ELEMENT_NAMES = new Map([
    [0x1A45DFA3, 'EBML'],
    [0x4286, 'EBMLVersion'],
    [0x42F7, 'EBMLReadVersion'],
    [0x42F2, 'EBMLMaxIDLength'],
    [0x42F3, 'EBMLMaxSizeLength'],
    [0x4282, 'DocType'],
    [0x4287, 'DocTypeVersion'],
    [0x4285, 'DocTypeReadVersion'],
    [0x18538067, 'Segment'],
    [0x1549A966, 'Info'],
    [0x2AD7B1, 'TimecodeScale'],
    [0x4489, 'Duration'],
    [0x4D80, 'MuxingApp'],
    [0x5741, 'WritingApp'],
    [0x1654AE6B, 'Tracks'],
    [0xAE, 'TrackEntry'],
    [0xD7, 'TrackNumber'],
    [0x73C5, 'TrackUID'],
    [0x83, 'TrackType'],
    [0x86, 'CodecID'],
    [0xE0, 'Video'],
    [0xB0, 'PixelWidth'],
    [0xBA, 'PixelHeight'],
    [0x1F43B675, 'Cluster'],
    [0xE7, 'Timecode'],
    [0xA3, 'SimpleBlock'],
    [0xA0, 'BlockGroup'],
    [0xA1, 'Block'],
    [0x1C53BB6B, 'Cues'],
    [0x114D9B74, 'SeekHead'],
    [0x1254C367, 'Tags'],
    [0xEC, 'Void'],
    [0xBF, 'CRC-32'],
  ]);

  const MASTER_IDS = new Set([
    0x1A45DFA3, 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0,
    0x1F43B675, 0xA0, 0x1C53BB6B, 0x114D9B74, 0x1254C367,
  ]);

  const ID = {
    EBML: 0x1A45DFA3,
    SEGMENT: 0x18538067,
    CLUSTER: 0x1F43B675,
    TIMECODE: 0xE7,
    SIMPLE_BLOCK: 0xA3,
    CUES: 0x1C53BB6B,
    VOID: 0xEC,
  };

  const MAX_DEPTH = 8;

  function hex(n) {
    return '0x' + n.toString(16).toUpperCase();
  }

  function nameOf(id) {
    return ELEMENT_NAMES.get(id) || 'Unknown';
  }

  /* 读取 EBML 变长整数。keepMarker=true 用于元素 ID（保留标记位）。
   * 返回 { value, length, unknown }；字节不足或首字节为 0 时返回 null。 */
  function readVint(buf, pos, end, keepMarker) {
    if (pos >= end) return null;
    const first = buf[pos];
    if (first === 0) return null;
    let mask = 0x80;
    let length = 1;
    while (length < 8 && !(first & mask)) {
      mask >>= 1;
      length++;
    }
    if (pos + length > end) return null;
    let value = keepMarker ? first : first & (mask - 1);
    let unknown = !keepMarker && (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < length; i++) {
      const byte = buf[pos + i];
      value = value * 256 + byte;
      if (!keepMarker && byte !== 0xFF) unknown = false;
    }
    return { value, length, unknown };
  }

  function readUint(buf, start, size) {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buf[start + i];
    return value;
  }

  /* 解析 [start, end) 区间内的兄弟元素序列。
   * 元素结构：{ id, idHex, name, start, headerSize, dataStart, size,
   *   unknownSize, end, truncated, children }。
   * 未知长度元素的 size 为 null，end 取父区间末尾。 */
  function parseElements(buf, start, end, depth, issues) {
    const elements = [];
    let pos = start;
    while (pos < end) {
      const elStart = pos;
      const id = readVint(buf, pos, end, true);
      if (!id) {
        issues.push({
          level: 'error',
          code: 'trailing-garbage',
          offset: elStart,
          length: end - elStart,
          message: `偏移 ${hex(elStart)} 起有 ${end - elStart} 字节无法解析为合法 EBML 元素头`,
        });
        break;
      }
      const sizePos = pos + id.length;
      const size = readVint(buf, sizePos, end, false);
      if (!size) {
        issues.push({
          level: 'error',
          code: 'truncated-element',
          offset: elStart,
          idHex: hex(id.value),
          message: `偏移 ${hex(elStart)} 的元素 ${nameOf(id.value)} (${hex(id.value)}) 尺寸字段被截断`,
        });
        break;
      }
      const dataStart = sizePos + size.length;
      const el = {
        id: id.value,
        idHex: hex(id.value),
        name: nameOf(id.value),
        start: elStart,
        headerSize: id.length + size.length,
        dataStart,
        size: size.unknown ? null : size.value,
        unknownSize: size.unknown,
        end: size.unknown ? end : dataStart + size.value,
        truncated: false,
        children: [],
      };
      if (!size.unknown && el.end > end) {
        el.truncated = true;
        el.end = end;
        issues.push({
          level: 'error',
          code: 'truncated-element',
          offset: elStart,
          idHex: el.idHex,
          declaredSize: size.value,
          available: end - dataStart,
          message: `偏移 ${hex(elStart)} 的元素 ${el.name} (${el.idHex}) 声明尺寸 ${size.value} 字节，`
            + `但缓冲区仅剩 ${end - dataStart} 字节（元素被截断）`,
        });
      }
      if (MASTER_IDS.has(id.value) && depth < MAX_DEPTH && el.end > dataStart) {
        el.children = parseElements(buf, dataStart, el.end, depth + 1, issues);
      }
      elements.push(el);
      pos = el.end;
      if (size.unknown) break; // 未知长度元素一直延伸到父元素末尾
    }
    return elements;
  }

  function walk(elements, fn) {
    for (const el of elements) {
      fn(el);
      if (el.children.length) walk(el.children, fn);
    }
  }

  /* 在元素树中收集 Cluster，附带时间码与结构信息。 */
  function collectClusters(elements, out) {
    for (const el of elements) {
      if (el.id === ID.CLUSTER) {
        const tc = el.children.find((c) => c.id === ID.TIMECODE);
        const blocks = el.children.filter(
          (c) => c.id === ID.SIMPLE_BLOCK || c.id === 0xA0
        ).length;
        out.push({
          start: el.start,
          end: el.end,
          size: el.end - el.start,
          timecode: tc && tc._uintValue !== undefined ? tc._uintValue : null,
          unknownSize: el.unknownSize,
          truncated: el.truncated || el.children.some((c) => c.truncated),
          blockCount: blocks,
        });
      } else if (el.children.length) {
        collectClusters(el.children, out);
      }
    }
    return out;
  }

  /* 解析单个分片缓冲区，返回 { elements, clusters, issues }。 */
  function parseBuffer(bytes) {
    const issues = [];
    const elements = parseElements(bytes, 0, bytes.length, 0, issues);
    walk(elements, (el) => {
      if (el.id === ID.TIMECODE && !el.unknownSize && el.size !== null && el.size <= 8) {
        el._uintValue = readUint(bytes, el.dataStart, el.size);
      }
    });
    const clusters = collectClusters(elements, []);
    return { elements, clusters, issues };
  }

  /* 对一组有序分片做整体结构分析。
   * chunks: [{ name, bytes: Uint8Array }]
   * 返回 { chunks, clusters, issues, totalBytes }，issues 的 offset 为拼接后的全局偏移。 */
  function analyzeChunks(chunkList) {
    const issues = [];
    const analyzed = [];
    const allClusters = [];
    let base = 0;

    chunkList.forEach((chunk, chunkIndex) => {
      const { elements, clusters, issues: local } = parseBuffer(chunk.bytes);
      for (const issue of local) {
        issues.push({ ...issue, offset: base + issue.offset, chunkIndex });
      }
      const entry = {
        name: chunk.name,
        chunkIndex,
        offset: base,
        size: chunk.bytes.length,
        elements,
        clusters,
        hasEbml: elements.length > 0 && elements[0].id === ID.EBML,
        hasSegment: elements.some((el) => el.id === ID.SEGMENT),
      };
      for (const cl of clusters) {
        allClusters.push({
          ...cl,
          chunkIndex,
          globalStart: base + cl.start,
          globalEnd: base + cl.end,
        });
      }
      analyzed.push(entry);
      base += chunk.bytes.length;
    });

    // 1) EBML 头检查
    if (analyzed.length === 0) {
      issues.push({ level: 'error', code: 'empty-input', offset: 0, message: '没有输入分片' });
    } else if (!analyzed[0].hasEbml) {
      issues.push({
        level: 'error',
        code: 'missing-ebml-header',
        offset: 0,
        chunkIndex: 0,
        message: `全局偏移 0x0 处不是 EBML 头（当前首个分片为「${analyzed[0].name}」），`
          + '拼接结果缺少 EBML/Segment 头，无法被解码器识别',
      });
    }
    analyzed.forEach((entry, i) => {
      if (i > 0 && entry.hasEbml) {
        issues.push({
          level: 'warn',
          code: 'duplicate-ebml-header',
          offset: entry.offset,
          chunkIndex: i,
          message: `分片「${entry.name}」在全局偏移 ${hex(entry.offset)} 处重复出现 EBML 头`
            + '（MediaRecorder 分段录制的典型现象，修复时会剔除）',
        });
      }
    });

    // 2) Cluster 时间码顺序与重复检查
    let maxTimecode = -1;
    const seenTimecodes = new Map();
    for (const cl of allClusters) {
      if (cl.timecode === null) {
        issues.push({
          level: 'warn',
          code: 'cluster-missing-timecode',
          offset: cl.globalStart,
          chunkIndex: cl.chunkIndex,
          message: `全局偏移 ${hex(cl.globalStart)} 处的 Cluster 缺少 Timecode 子元素`,
        });
        continue;
      }
      if (seenTimecodes.has(cl.timecode)) {
        issues.push({
          level: 'error',
          code: 'duplicate-cluster',
          offset: cl.globalStart,
          otherOffset: seenTimecodes.get(cl.timecode),
          chunkIndex: cl.chunkIndex,
          timecode: cl.timecode,
          message: `全局偏移 ${hex(cl.globalStart)} 处的 Cluster 时间码 ${cl.timecode} `
            + `与偏移 ${hex(seenTimecodes.get(cl.timecode))} 处的 Cluster 重复`,
        });
      } else {
        seenTimecodes.set(cl.timecode, cl.globalStart);
      }
      if (cl.timecode < maxTimecode) {
        issues.push({
          level: 'error',
          code: 'cluster-out-of-order',
          offset: cl.globalStart,
          chunkIndex: cl.chunkIndex,
          timecode: cl.timecode,
          prevTimecode: maxTimecode,
          message: `全局偏移 ${hex(cl.globalStart)} 处的 Cluster 时间码 ${cl.timecode} `
            + `小于之前已出现的最大时间码 ${maxTimecode}（分片顺序错误）`,
        });
      }
      if (cl.timecode > maxTimecode) maxTimecode = cl.timecode;
    }

    // 3) 未知长度元素（信息级）
    analyzed.forEach((entry, chunkIndex) => {
      walk(entry.elements, (el) => {
        if (el.unknownSize) {
          issues.push({
            level: 'info',
            code: 'unknown-length-element',
            offset: entry.offset + el.start,
            chunkIndex,
            message: `全局偏移 ${hex(entry.offset + el.start)} 处的 ${el.name} (${el.idHex}) `
              + '使用未知长度（0xFF…），尺寸延伸到父元素/分片末尾',
          });
        }
      });
    });

    if (analyzed.length > 0 && allClusters.length === 0) {
      issues.push({
        level: 'warn',
        code: 'no-clusters',
        offset: 0,
        message: '所有分片中都没有找到 Cluster',
      });
    }

    return { chunks: analyzed, clusters: allClusters, issues, totalBytes: base };
  }

  return {
    ELEMENT_NAMES,
    ID,
    readVint,
    readUint,
    parseBuffer,
    analyzeChunks,
    hex,
  };
});
