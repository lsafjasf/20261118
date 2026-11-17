import { mkdirSync, writeFileSync } from "node:fs";
import { SCENARIOS, getScenario } from "../src/scenarios.js";
import { solveTimeline } from "../src/solver.js";

const report = [];

for (const item of SCENARIOS) {
  const scenario = getScenario(item.id);
  const result = solveTimeline(scenario.state, scenario.request || {});
  report.push({
    case: item.id,
    title: item.title,
    request: scenario.request,
    status: result.ok ? "applied" : "blocked",
    summary: result.summary,
    moves: result.moves,
    conflicts: result.conflicts,
  });

  console.log(`\nCASE ${item.number} · ${item.title} · ${result.ok ? "APPLIED" : "BLOCKED"}`);
  if (result.ok) {
    console.log(
      `  minimum solver moves: ${result.summary.adjusted} | total moved: ${result.summary.totalMoved} | kept: ${result.summary.kept} | min gap: ${result.summary.minGap}s`,
    );
    if (!result.moves.length) {
      console.log("  moves: none");
    } else {
      for (const move of result.moves) {
        const route = `${move.fromTrack.toUpperCase()} ${move.fromStart.toFixed(2)} → ${move.toTrack.toUpperCase()} ${move.toStart.toFixed(2)}`;
        const delta = move.fromTrack !== move.toTrack ? "cross-track" : `${move.delta >= 0 ? "+" : ""}${move.delta.toFixed(2)}s`;
        console.log(`  - ${move.label.padEnd(12)} ${route.padEnd(22)} ${delta.padEnd(12)} ${move.reason}`);
      }
    }
  } else {
    console.log("  applied moves: 0 (layout preserved)");
    for (const conflict of result.conflicts) {
      console.log(`  ! ${conflict.kind}: [${conflict.clips.join(", ")}] ${conflict.message}`);
    }
  }
}

mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/solve-report.json", `${JSON.stringify(report, null, 2)}\n`);
console.log("\nJSON report: artifacts/solve-report.json");
