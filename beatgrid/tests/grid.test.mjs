import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeCanvas() {
  return {
    style: {},
    width: 1000,
    height: 220,
    getBoundingClientRect: () => ({ width: 1000, height: 220, left: 0, top: 0 }),
    getContext: () => ({
      setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {},
      moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fillText() {},
      fill() {}, strokeRect() {},
      set fillStyle(_) {}, get fillStyle() { return ""; },
      set strokeStyle(_) {}, get strokeStyle() { return ""; },
      set lineWidth(_) {}, get lineWidth() { return 1; },
      set font(_) {}, get font() { return ""; },
      set globalAlpha(_) {}, get globalAlpha() { return 1; },
      setLineDash() {},
    }),
    addEventListener() {},
  };
}

async function boot() {
  const html = readFileSync(path.join(root, "web/index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.devicePixelRatio = 1;
  window.fetch = async (url) => {
    const rel = url.replace(/^\.\.\//, "");
    if (rel.endsWith(".wav")) {
      return { arrayBuffer: async () => new ArrayBuffer(64) };
    }
    const body = readFileSync(path.join(root, rel), "utf8");
    return { json: async () => JSON.parse(body) };
  };
  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; }
    decodeAudioData() { return Promise.resolve({ duration: 20 }); }
    createBufferSource() {
      return {
        connect() {}, start() {}, stop() {}, disconnect() {},
        buffer: null,
      };
    }
  };
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const stubs = new Map();
  for (const id of ["wave-canvas", "overlay-canvas", "bpm-canvas"]) {
    stubs.set(id, Object.assign(makeCanvas(), { id }));
  }
  const originalGet = window.document.getElementById.bind(window.document);
  window.document.getElementById = (id) => stubs.get(id) || originalGet(id);
  const code = readFileSync(path.join(root, "web/app.js"), "utf8");
  window.eval(code);
  await new Promise((r) => setTimeout(r, 30));
  return { window, dom, stubs };
}

test("loads constant track and shows metrics", async () => {
  const { window } = await boot();
  const doc = window.document;
  assert.equal(doc.getElementById("mode-badge").textContent, "恒定 BPM");
  assert.match(doc.getElementById("m-confidence").textContent, /%/);
  assert.match(doc.getElementById("m-mae").textContent, /ms/);
  const rows = doc.querySelectorAll("#bpm-table tbody tr");
  assert.ok(rows.length >= 2);
});

test("half-beat nudge shifts grid from selected point onward", async () => {
  const { window } = await boot();
  const s = window.__beatgrid.state;
  const before = s.grid.map((g) => g.time);
  s.selectedIndex = s.grid[4].index;
  window.__beatgrid.nudge(1);
  const after = s.grid.map((g) => g.time);
  const period = before[5] - before[4];
  assert.ok(Math.abs(after[3] - before[3]) < 1e-9);
  assert.ok(Math.abs((after[4] - before[4]) - period * 0.5) < 1e-6);
  assert.ok(Math.abs((after[8] - before[8]) - period * 0.5) < 1e-6);
});

test("bar nudge moves exactly four beats of time", async () => {
  const { window } = await boot();
  const s = window.__beatgrid.state;
  const byIndex = new Map(s.grid.map((g) => [g.index, g.time]));
  const target = s.grid[8];
  const neighbor = s.grid[7];
  s.selectedIndex = target.index;
  const unitSelect = window.document.getElementById("nudge-unit");
  unitSelect.value = "bar";
  unitSelect.querySelector('option[value="bar"]').selected = true;
  window.__beatgrid.nudge(-1);
  const period = byIndex.get(target.index + 1) - byIndex.get(target.index);
  const afterTarget = s.grid.find((g) => g.index === target.index).time;
  const afterNeighbor = s.grid.find((g) => g.index === neighbor.index).time;
  assert.ok(Math.abs(afterNeighbor - byIndex.get(neighbor.index)) < 1e-9);
  assert.ok(Math.abs((byIndex.get(target.index) - afterTarget) - period * 4) < 1e-6);
});

for (const [name, mode] of [["accelerando", "ramp"], ["free", "free"]]) {
  test(`track ${name} classifies as ${mode}`, async () => {
    const { window } = await boot();
    const sel = window.document.getElementById("track-select");
    sel.value = name;
    sel.dispatchEvent(new window.Event("change"));
    await new Promise((r) => setTimeout(r, 30));
    const s = window.__beatgrid.state;
    assert.equal(s.analysis.mode, mode);
    if (mode === "free") {
      assert.match(
        window.document.getElementById("m-mae").textContent,
        /自由拍/
      );
    }
  });
}

test("free mode nudge moves only the selected point", async () => {
  const { window } = await boot();
  const sel = window.document.getElementById("track-select");
  sel.value = "free";
  sel.dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 30));
  const s = window.__beatgrid.state;
  const before = s.grid.map((g) => g.time);
  s.selectedIndex = s.grid[5].index;
  window.__beatgrid.nudge(1);
  const after = s.grid.map((g) => g.time);
  assert.ok(Math.abs(after[4] - before[4]) < 1e-9);
  assert.ok(Math.abs(after[6] - before[6]) < 1e-9);
  assert.ok(after[5] > before[5]);
});

test("grid edit recomputes BPM curve and keeps it monotonic in time", async () => {
  const { window } = await boot();
  const s = window.__beatgrid.state;
  s.selectedIndex = s.grid[4].index;
  const originalBpm = s.analysis.bpm_curve.map((c) => c[1]);
  window.__beatgrid.nudge(1);
  const curve = s.derivedBpm;
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i][0] >= curve[i - 1][0]);
  }
  const afterBpm = curve.map((c) => c[1]);
  assert.notDeepEqual(originalBpm, afterBpm);
  const tableRows = window.document.querySelectorAll("#bpm-table tbody tr").length;
  assert.equal(tableRows, curve.length);
});
