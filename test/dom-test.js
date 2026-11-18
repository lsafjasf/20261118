/* jsdom integration: boot the real page, verify segments/metrics/edit flow. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost/"
});
const { window } = dom;

// Minimal 2D context stub (jsdom has no canvas rendering).
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, { get: (t, p) => {
    if (p === "canvas") return this;
    return typeof p === "string" ? () => {} : undefined;
  }, set: () => true });
};
window.HTMLCanvasElement.prototype.clientWidth = 900;
window.HTMLCanvasElement.prototype.clientHeight = 180;
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};

function loadScript(rel) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  window.eval(code);
}
for (const f of ["src/fft.js", "src/features.js", "src/vad.js", "src/metrics.js",
  "src/test-signal.js", "src/wav-codec.js", "src/timeline.js", "src/app.js"]) {
  loadScript(f);
}

window.dispatchEvent(new window.Event("DOMContentLoaded"));

const $ = (id) => window.document.getElementById(id);
const assert = require("assert");

(function run() {
  const rows = () => window.document.querySelectorAll("#segment-rows tr");
  assert.ok(rows().length >= 8, "auto-detected segments rendered");
  assert.ok($("total-all").textContent !== "0", "totals computed");
  const totalBefore = parseFloat($("total-all").textContent);
  const speechBefore = parseFloat($("total-speech").textContent);
  assert.ok(/dB/.test($("thresholds").textContent), "adaptive thresholds shown");
  assert.ok(/%/.test($("metrics-body").textContent), "metrics rendered");

  // Simulate dragging the end of the first speech segment earlier by editing
  // the table cell (same setBoundary path as canvas drag handlers).
  const firstSpeechRow = [...rows()].find((r) => r.textContent.includes("speech"));
  const endCell = firstSpeechRow.querySelector(".edit-end");
  const originalEnd = parseFloat(endCell.textContent);
  endCell.textContent = (originalEnd - 0.5).toFixed(3);
  endCell.dispatchEvent(new window.Event("blur"));

  const speechAfter = parseFloat($("total-speech").textContent);
  assert.ok(Math.abs((speechBefore - speechAfter) - 0.5) < 0.02,
    "speech total recalculated after boundary edit");
  assert.ok(Math.abs(parseFloat($("total-all").textContent) - totalBefore) < 0.02,
    "grand total stays equal to clip duration after edit");

  // Tolerance selector re-renders metrics without errors.
  $("tolerance").value = "0.2";
  $("tolerance").dispatchEvent(new window.Event("change"));
  assert.ok(/%/.test($("metrics-body").textContent), "metrics still valid after retune");

  console.log("rows:", rows().length);
  console.log("totals before:", speechBefore, "-> after:", speechAfter.toFixed(3));
  console.log("metrics text:", $("metrics-body").textContent.replace(/\s+/g, " ").trim());
  console.log("DOM integration test passed.");
  process.exit(0);
})();
