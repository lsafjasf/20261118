/* Smoke-test the UI wiring under jsdom using the synthetic fixture. */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const fixture = path.join(__dirname, "fixtures", "sample-anomalies.opus");
if (!fs.existsSync(fixture)) {
  execFileSync("python3", [path.join(root, "tools", "make_sample.py"), fixture]);
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
const { window } = dom;

// Stubs jsdom lacks.
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLCanvasElement.prototype.getContext = () =>
  new Proxy({}, { get: (t, prop) => (prop === "measureText" ? () => ({ width: 0 }) : () => {}) });

window.eval(fs.readFileSync(path.join(root, "js", "opus-parser.js"), "utf8"));
window.eval(fs.readFileSync(path.join(root, "js", "app.js"), "utf8"));

const bytes = fs.readFileSync(fixture);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const file = new window.File([buffer], "sample-anomalies.opus", { type: "audio/ogg" });

// FileReader in jsdom is sync-ish via event loop; drive it and then assert.
const input = window.document.getElementById("file-input");
Object.defineProperty(input, "files", { value: [file], configurable: true });
input.dispatchEvent(new window.Event("change"));

setTimeout(() => {
  const doc = window.document;
  const rows = doc.querySelectorAll("#anomaly-table tbody tr");
  const summary = doc.getElementById("summary-list").textContent;
  const failures = [];
  if (doc.getElementById("report").hidden) failures.push("report still hidden");
  if (rows.length !== 7) failures.push(`expected 7 anomaly rows, got ${rows.length}`);
  if (!summary.includes("16000 Hz")) failures.push("summary missing input rate");
  if (!summary.includes("312")) failures.push("summary missing pre-skip");
  if (!doc.getElementById("anomaly-count").textContent.includes("7")) {
    failures.push("anomaly count label wrong");
  }
  // Click the first row to exercise audition + selection paths.
  if (rows.length) rows[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (doc.getElementById("player-bar").hidden) failures.push("player bar did not show");
  // Export handlers should not throw.
  doc.getElementById("export-csv").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  doc.getElementById("export-json").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  if (failures.length) {
    console.error("FAIL\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log("ui smoke test passed");
  process.exit(0);
}, 200);
