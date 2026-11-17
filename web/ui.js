// Browser UI driver: builds the index, runs query variants, renders top 3.
import { generateSong } from "../src/song.js";
import { clip, addNoise, resampleAt, pitchShift } from "../src/variants.js";
import { createMatcher, CONFIDENCE_THRESHOLD } from "../src/fingerprint.js";

const SONG_IDS = [1, 2, 3];
const TARGET = 1;

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const resultsPanel = document.getElementById("results-panel");
const resultsTitle = document.getElementById("results-title");
const resultsBody = document.getElementById("results-body");
const queryButtons = [...document.querySelectorAll("#query-buttons button")];

let matcher = null;
let songs = null;
let unrelated = null;

function log(msg) {
  logEl.textContent += msg + "\n";
}

async function boot() {
  try {
    const resp = await fetch("../build/fingerprint.wasm");
    matcher = await createMatcher(await resp.arrayBuffer());
    statusEl.textContent = "WASM 已加载，可以建立索引。";
  } catch (e) {
    statusEl.textContent = "WASM 加载失败: " + e.message;
  }
}

document.getElementById("btn-index").addEventListener("click", () => {
  matcher.resetIndex();
  songs = new Map();
  logEl.textContent = "";
  for (const id of SONG_IDS) {
    const pcm = generateSong(id * 1000 + 7, 40);
    songs.set(id, pcm);
    const hashes = matcher.indexSong(id, pcm);
    log(`歌曲 ${id}: ${hashes} 个哈希已入倒排索引`);
  }
  unrelated = generateSong(424242, 40);
  log("无关音频已生成（未入库）。");
  statusEl.textContent = "索引完成，可以查询。";
  queryButtons.forEach((b) => (b.disabled = false));
});

function buildQuery(kind) {
  const target = songs.get(TARGET);
  switch (kind) {
    case "clean": return ["原始剪辑 (t=10s, 12s)", clip(target, 10, 12)];
    case "noisy": return ["加噪剪辑 (SNR 5dB)", addNoise(clip(target, 10, 12), 5)];
    case "fast": return ["加速剪辑 (1.06x)", resampleAt(clip(target, 10, 15), 1.06)];
    case "pitch": return ["变调剪辑 (+2 半音)", pitchShift(clip(target, 10, 12), 2)];
    case "unrelated": return ["无关音频剪辑", clip(unrelated, 10, 12)];
  }
}

function render(title, top3) {
  resultsPanel.hidden = false;
  resultsTitle.textContent = `查询：${title} — 前 ${top3.length} 个候选`;
  resultsBody.innerHTML = "";
  top3.forEach((c, i) => {
    const hit = c.confidence >= CONFIDENCE_THRESHOLD;
    const tr = document.createElement("tr");
    const pct = Math.min(100, c.confidence * 100);
    const thPct = CONFIDENCE_THRESHOLD * 100;
    tr.innerHTML =
      `<td class="rank">${i + 1}</td>` +
      `<td class="mono">歌曲 ${c.songId}</td>` +
      `<td class="mono">${c.offsetSec.toFixed(2)} s (tempo x${c.tempoRatio}, 音高 ${c.pitchBins >= 0 ? "+" : ""}${c.pitchBins} bins)</td>` +
      `<td class="mono">${c.matches} / ${c.queryHashes}</td>` +
      `<td><span class="conf-bar"><span class="conf-fill ${hit ? "" : "low"}" style="width:${pct}%"></span>` +
      `<span class="conf-threshold" style="left:${thPct}%"></span></span> ` +
      `<span class="mono">${c.confidence.toFixed(3)}</span></td>` +
      `<td><span class="badge ${hit ? "hit" : "miss"}">${hit ? "命中" : "低于阈值"}</span></td>`;
    resultsBody.appendChild(tr);
  });
}

for (const btn of queryButtons) {
  btn.addEventListener("click", () => {
    const [title, pcm] = buildQuery(btn.dataset.case);
    const top3 = matcher.queryTop3(pcm);
    render(title, top3);
  });
}

boot();
