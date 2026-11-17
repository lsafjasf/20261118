/*
 * Ogg Opus packet sequence inspector.
 * Parses the Ogg container and Opus TOC headers, computes per-packet
 * durations from granule positions, and localizes anomalies (timestamp
 * rollback, duplicate packets, sample-rate declaration mismatches,
 * loss gaps, pre-skip inconsistencies) to individual packet indices.
 * Works in the browser (window.OpusInspector) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OpusInspector = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const OPUS_RATE = 48000; // Opus always decodes at 48 kHz internally.

  // RFC 6716 Table 2: config -> { mode, bandwidth, bandwidthRate, frameMs }.
  const CONFIG_TABLE = (function () {
    const table = [];
    const silkBw = [
      ["NB", 8000],
      ["MB", 12000],
      ["WB", 16000],
    ];
    for (let i = 0; i < 12; i++) {
      const bw = silkBw[Math.floor(i / 4)];
      table.push({ mode: "SILK", bandwidth: bw[0], bandwidthRate: bw[1], frameMs: [10, 20, 40, 60][i % 4] });
    }
    const hybBw = [
      ["SWB", 24000],
      ["FB", 48000],
    ];
    for (let i = 12; i < 16; i++) {
      const bw = hybBw[Math.floor((i - 12) / 2)];
      table.push({ mode: "Hybrid", bandwidth: bw[0], bandwidthRate: bw[1], frameMs: [10, 20][i % 2] });
    }
    const celtBw = [
      ["NB", 8000],
      ["WB", 16000],
      ["SWB", 24000],
      ["FB", 48000],
    ];
    for (let i = 16; i < 32; i++) {
      const bw = celtBw[Math.floor((i - 16) / 4)];
      table.push({ mode: "CELT", bandwidth: bw[0], bandwidthRate: bw[1], frameMs: [2.5, 5, 10, 20][i % 4] });
    }
    return table;
  })();

  function msToSamples48k(ms) {
    return Math.round(ms * 48);
  }

  // Parse one Opus packet's TOC (and frame-count byte for code 3).
  // Returns null when the packet is structurally invalid.
  function parsePacket(packet) {
    if (packet.length < 1) return null;
    const toc = packet[0];
    const config = toc >> 3;
    const stereo = ((toc >> 2) & 1) === 1;
    const code = toc & 3;
    const info = CONFIG_TABLE[config];
    let frameCount;
    if (code === 0) frameCount = 1;
    else if (code === 1 || code === 2) frameCount = 2;
    else {
      if (packet.length < 2) return null;
      frameCount = packet[1] & 0x3f;
      if (frameCount < 1 || frameCount > 48) return null;
    }
    const frameSamples = msToSamples48k(info.frameMs);
    const durationSamples = frameCount * frameSamples;
    if (durationSamples > 5760) return null; // > 120 ms is not a valid Opus packet.
    return {
      toc,
      config,
      stereo,
      code,
      mode: info.mode,
      bandwidth: info.bandwidth,
      impliedRate: info.bandwidthRate,
      frameMs: info.frameMs,
      frameCount,
      durationSamples,
      durationMs: durationSamples / 48,
    };
  }

  function fnv1a(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  // Split a byte buffer into Ogg pages.
  function parsePages(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const pages = [];
    let pos = 0;
    while (pos + 27 <= buf.length) {
      if (buf[pos] !== 0x4f || buf[pos + 1] !== 0x67 || buf[pos + 2] !== 0x67 || buf[pos + 3] !== 0x53) {
        const next = buf.indexOf(0x4f, pos + 1);
        if (next === -1) break;
        pos = next;
        continue;
      }
      const version = buf[pos + 4];
      if (version !== 0) {
        pos += 5;
        continue;
      }
      const headerType = buf[pos + 5];
      const granule = Number(view.getBigInt64(pos + 6, true));
      const serial = view.getUint32(pos + 14, true);
      const sequence = view.getUint32(pos + 18, true);
      const segmentCount = buf[pos + 26];
      const segTableStart = pos + 27;
      if (segTableStart + segmentCount > buf.length) break;
      let payloadLength = 0;
      for (let i = 0; i < segmentCount; i++) payloadLength += buf[segTableStart + i];
      const payloadStart = segTableStart + segmentCount;
      if (payloadStart + payloadLength > buf.length) break;
      const lacing = [];
      for (let i = 0; i < segmentCount; i++) lacing.push(buf[segTableStart + i]);
      pages.push({
        index: pages.length,
        headerType,
        continued: (headerType & 1) !== 0,
        beginStream: (headerType & 2) !== 0,
        endStream: (headerType & 4) !== 0,
        granule,
        serial,
        sequence,
        lacing,
        payload: buf.subarray(payloadStart, payloadStart + payloadLength),
      });
      pos = payloadStart + payloadLength;
    }
    return pages;
  }

  // Reassemble packets from the pages of one logical stream.
  // Each packet records the page on which it completed.
  function assemblePackets(pages) {
    const packets = [];
    let partial = [];
    let partialStartPage = -1;
    for (const page of pages) {
      if (!page.continued && partial.length) partial = []; // dropped continuation
      let offset = 0;
      for (const lace of page.lacing) {
        partial.push(page.payload.subarray(offset, offset + lace));
        offset += lace;
        if (lace < 255) {
          const size = partial.reduce((sum, chunk) => sum + chunk.length, 0);
          const data = new Uint8Array(size);
          let at = 0;
          for (const chunk of partial) {
            data.set(chunk, at);
            at += chunk.length;
          }
          packets.push({ data, page: page.index, startPage: partialStartPage === -1 ? page.index : partialStartPage });
          partial = [];
          partialStartPage = -1;
        } else if (partialStartPage === -1) {
          partialStartPage = page.index;
        }
      }
    }
    return packets;
  }

  function readAscii(bytes, start, length) {
    let out = "";
    for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function parseOpusHead(data) {
    if (data.length < 19 || readAscii(data, 0, 8) !== "OpusHead") return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      version: data[8],
      channels: data[9],
      preSkip: view.getUint16(10, true),
      inputRate: view.getUint32(12, true),
      outputGain: view.getInt16(16, true),
      mappingFamily: data[18],
    };
  }

  // Assign a granule position to every packet. A page's granule belongs to
  // the last packet completed on that page; earlier packets on the same page
  // are derived by walking backwards over their durations. Pages that end
  // with an incomplete packet carry granule -1 and fall back to forward
  // accumulation from the previous known position.
  function assignGranules(packets, pages) {
    const byPage = new Map();
    packets.forEach((pkt, i) => {
      if (!byPage.has(pkt.page)) byPage.set(pkt.page, []);
      byPage.get(pkt.page).push(i);
    });
    let forward = 0;
    for (const page of pages) {
      const idxs = byPage.get(page.index) || [];
      if (!idxs.length) continue;
      if (page.granule >= 0) {
        let gp = page.granule;
        for (let k = idxs.length - 1; k >= 0; k--) {
          packets[idxs[k]].granule = gp;
          gp -= packets[idxs[k]].parsed ? packets[idxs[k]].parsed.durationSamples : 0;
        }
        forward = page.granule;
      } else {
        for (const i of idxs) {
          packets[i].granule = forward + (packets[i].parsed ? packets[i].parsed.durationSamples : 0);
          forward = packets[i].granule;
        }
      }
    }
  }

  const SEVERITY = { error: "error", warning: "warning", info: "info" };

  function analyze(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    const pages = parsePages(buf);
    if (!pages.length) throw new Error("未找到任何 Ogg 页，文件可能不是 Ogg 封装。");

    const serials = [];
    for (const page of pages) if (!serials.includes(page.serial)) serials.push(page.serial);

    let streamPages = null;
    let header = null;
    let packets = null;
    for (const serial of serials) {
      const candidatePages = pages.filter((p) => p.serial === serial);
      const candidatePackets = assemblePackets(candidatePages);
      const head = candidatePackets.length ? parseOpusHead(candidatePackets[0].data) : null;
      if (head) {
        streamPages = candidatePages;
        header = head;
        packets = candidatePackets;
        break;
      }
    }
    if (!header) throw new Error("未找到 OpusHead 头包，文件可能不是 Ogg Opus。");

    const anomalies = [];
    const addAnomaly = (packetIndex, type, severity, message, extra) =>
      anomalies.push(Object.assign({ packetIndex, type, severity, message, timeMs: null }, extra));

    // Locate header packets; everything after OpusTags is audio.
    let audioStart = 1;
    if (packets.length > 1 && readAscii(packets[1].data, 0, 8) === "OpusTags") audioStart = 2;

    const audio = [];
    for (let i = audioStart; i < packets.length; i++) {
      const data = packets[i].data;
      const chainedHead = parseOpusHead(data);
      if (chainedHead) {
        if (chainedHead.inputRate !== header.inputRate) {
          addAnomaly(i, "rate_mismatch", SEVERITY.error,
            `链式流在第 ${i} 包重新声明采样率 ${chainedHead.inputRate} Hz，与初始声明 ${header.inputRate} Hz 不一致`);
        }
        continue;
      }
      const parsed = parsePacket(data);
      const entry = {
        index: i,
        page: packets[i].page,
        size: data.length,
        hash: fnv1a(data),
        parsed,
        granule: null,
        flags: [],
      };
      if (!parsed) {
        entry.flags.push("invalid_toc");
        addAnomaly(i, "invalid_toc", SEVERITY.error, `第 ${i} 包 TOC 头非法，无法确定帧数或时长`);
      }
      audio.push(entry);
      packets[i].parsed = parsed;
      packets[i].entry = entry;
    }

    // Granule assignment over packet records with page info.
    const packetRecords = audio.map((e) => ({ parsed: e.parsed, page: e.page, granule: null }));
    assignGranules(packetRecords, streamPages);
    audio.forEach((e, k) => {
      e.granule = packetRecords[k].granule;
      e.timeMs = e.granule === null ? null : Math.max(0, (e.granule - header.preSkip) / (OPUS_RATE / 1000));
      e.durationMs = e.parsed ? e.parsed.durationMs : 0;
    });

    // Per-packet checks against the declared input sample rate.
    const declared = header.inputRate;
    for (const e of audio) {
      if (!e.parsed) continue;
      if (declared > 0 && e.parsed.impliedRate > declared) {
        e.flags.push("rate_mismatch");
        addAnomaly(e.index, "rate_mismatch", SEVERITY.error,
          `第 ${e.index} 包 TOC 声明 ${e.parsed.bandwidth}（${e.parsed.impliedRate} Hz），超出 OpusHead 声明的输入采样率 ${declared} Hz`,
          { timeMs: e.timeMs });
      }
    }

    // The last packet of the stream may be end-trimmed: the EOS page
    // granule legitimately advances by less than the packet duration.
    const lastAudio = audio[audio.length - 1];
    const lastPage = lastAudio ? streamPages[lastAudio.page] : null;
    const endTrimmedIndex = lastPage && lastPage.endStream ? lastAudio.index : -1;

    // Timestamp continuity checks. A granule position is a cumulative end
    // time, so the expected advance between two packets equals the duration
    // of the current packet.
    for (let k = 1; k < audio.length; k++) {
      const prev = audio[k - 1];
      const cur = audio[k];
      if (prev.granule === null || cur.granule === null || !cur.parsed) continue;
      const delta = cur.granule - prev.granule;
      const expected = cur.parsed.durationSamples;
      if (delta < 0) {
        cur.flags.push("timestamp_rollback");
        addAnomaly(cur.index, "timestamp_rollback", SEVERITY.error,
          `第 ${cur.index} 包时间戳回退 ${-delta} 样本（${prev.granule} → ${cur.granule}）`,
          { timeMs: cur.timeMs, deltaSamples: delta });
      } else if (delta === 0) {
        cur.flags.push("duplicate_timestamp");
        addAnomaly(cur.index, "duplicate_packet", SEVERITY.warning,
          `第 ${cur.index} 包时间戳与第 ${prev.index} 包相同（granule=${cur.granule}），疑似重复包`,
          { timeMs: cur.timeMs });
      } else if (delta < expected) {
        if (cur.index === endTrimmedIndex) continue; // legal EOS end trim
        cur.flags.push("timestamp_overlap");
        addAnomaly(cur.index, "timestamp_overlap", SEVERITY.warning,
          `第 ${cur.index} 包时间戳重叠 ${expected - delta} 样本`,
          { timeMs: cur.timeMs, deltaSamples: delta });
      } else if (delta > expected) {
        cur.flags.push("gap");
        addAnomaly(cur.index, "gap", SEVERITY.warning,
          `第 ${prev.index} 包与第 ${cur.index} 包之间存在 ${delta - expected} 样本空档（约 ${((delta - expected) / 48).toFixed(1)} ms），疑似丢包`,
          { timeMs: cur.timeMs, gapSamples: delta - expected });
      }
      if (cur.hash === prev.hash && cur.size === prev.size) {
        cur.flags.push("duplicate_payload");
        addAnomaly(cur.index, "duplicate_packet", SEVERITY.warning,
          `第 ${cur.index} 包负载与第 ${prev.index} 包完全一致，疑似重复包`,
          { timeMs: cur.timeMs });
      }
    }

    // Pre-skip sanity: granule positions count pre-skip samples, so the
    // first audio page's granule must not exceed the samples on that page,
    // and the stream must contain at least pre-skip samples overall.
    if (audio.length && audio[0].granule !== null) {
      const firstPageIdx = audio[0].page;
      const firstPagePackets = audio.filter((e) => e.page === firstPageIdx && e.parsed);
      const sumDur = firstPagePackets.reduce((s, e) => s + e.parsed.durationSamples, 0);
      const page = streamPages[firstPageIdx];
      if (page && page.granule > sumDur) {
        addAnomaly(audio[0].index, "preskip_inconsistent", SEVERITY.error,
          `首个音频页 granule（${page.granule}）超过该页样本总数（${sumDur}），时间轴起点非法`,
          { timeMs: 0 });
      }
      const total = audio.reduce((s, e) => s + (e.parsed ? e.parsed.durationSamples : 0), 0);
      if (header.preSkip > total) {
        addAnomaly(audio[0].index, "preskip_inconsistent", SEVERITY.error,
          `OpusHead 声明的预跳 ${header.preSkip} 样本超过整流总样本数 ${total}`,
          { timeMs: 0 });
      }
    }

    for (const a of anomalies) {
      if (a.timeMs === null) {
        const e = audio.find((x) => x.index === a.packetIndex);
        a.timeMs = e && e.timeMs !== null ? e.timeMs : 0;
      }
    }

    const totalSamples = audio.reduce((s, e) => s + (e.parsed ? e.parsed.durationSamples : 0), 0);
    return {
      header,
      pageCount: streamPages.length,
      packetCount: packets.length,
      audioPacketCount: audio.length,
      packets: audio,
      anomalies,
      stats: {
        totalDurationMs: totalSamples / 48,
        gapCount: anomalies.filter((a) => a.type === "gap").length,
        lostSamples: anomalies.reduce((s, a) => s + (a.gapSamples || 0), 0),
        preSkipMs: header.preSkip / 48,
      },
    };
  }

  return { analyze, parsePacket, parsePages, assemblePackets, CONFIG_TABLE, OPUS_RATE };
});
