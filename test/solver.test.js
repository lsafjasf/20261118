import test from "node:test";
import assert from "node:assert/strict";
import { getScenario } from "../src/scenarios.js";
import { solveTimeline, validateTimeline } from "../src/solver.js";

const baseTracks = [
  { id: "v1", label: "V1", name: "Main" },
  { id: "v2", label: "V2", name: "Overlay" },
];

function makeState(clips, orders, options = {}) {
  return {
    minGap: options.minGap ?? 0.5,
    tracks: structuredClone(baseTracks),
    clips,
    orders,
    precedence: options.precedence ?? [],
  };
}

test("dragging Intro shifts the downstream V1 chain and keeps other tracks parallel", () => {
  const scenario = getScenario("shift");
  const result = solveTimeline(scenario.state, scenario.request);

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalMoved, 4);
  assert.equal(result.summary.adjusted, 3);
  assert.equal(result.summary.tracksTouched, 1);
  assert.deepEqual(validateTimeline(result.positions, 0.5), []);

  const positions = Object.fromEntries(result.positions.map((clip) => [clip.id, clip]));
  assert.equal(positions.intro.start, 2);
  assert.equal(positions.build.start, 5.5);
  assert.equal(positions.drop.start, 9);
  assert.equal(positions.outro.start, 12.5);
  assert.equal(positions.overlay.start, 1.5);
  assert.equal(positions.title.start, 8);
  assert.equal(positions.music.start, 0);
  assert.deepEqual(
    result.moves.map((move) => move.delta),
    [2, 2, 2, 2],
  );
});

test("a cyclic precedence constraint is rejected without moving clips", () => {
  const scenario = getScenario("cycle");
  const result = solveTimeline(scenario.state, scenario.request);

  assert.equal(result.ok, false);
  assert.equal(result.moves.length, 0);
  assert.equal(result.conflicts[0].kind, "cycle");
  assert.deepEqual(result.conflicts[0].clips, ["cycle-a", "cycle-b", "cycle-c"]);
  assert.match(result.conflicts[0].message, /Cycle A → Cycle B → Cycle C → Cycle A/);
});

test("overlapping locked clips report both conflicting clips", () => {
  const scenario = getScenario("locked-overlap");
  const result = solveTimeline(scenario.state, {});

  assert.equal(result.ok, false);
  assert.equal(result.moves.length, 0);
  assert.deepEqual(result.conflicts[0].clips, ["lock-a", "lock-b"]);
  assert.equal(result.conflicts[0].kind, "locked-collision");
  assert.equal(result.conflicts[0].required, 3.5);
  assert.equal(result.conflicts[0].available, 3.2);
});

test("a drag target blocked by a lock reports the drag-lock pair", () => {
  const scenario = getScenario("drag-locked");
  const result = solveTimeline(scenario.state, scenario.request);

  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts[0].clips, ["drag-d", "drag-lock"]);
  assert.equal(result.conflicts[0].kind, "drag-locked");
});

test("minimum motion moves only one clip when a single gap is invalid", () => {
  const state = makeState(
    [
      { id: "a", label: "A", track: "v1", start: 0, duration: 2, priority: 3, locked: false },
      { id: "b", label: "B", track: "v1", start: 2.25, duration: 2, priority: 3, locked: false },
      { id: "parallel", label: "Parallel", track: "v2", start: 0, duration: 3, priority: 1, locked: false },
    ],
    { v1: ["a", "b"], v2: ["parallel"] },
  );

  const result = solveTimeline(state, {});
  assert.equal(result.ok, true);
  assert.equal(result.summary.adjusted, 1);
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].id, "b");
  assert.equal(result.moves[0].toStart, 2.5);
  assert.deepEqual(validateTimeline(result.positions, 0.5), []);
});

test("priority breaks ties only after the moved-clip count is minimized", () => {
  const state = makeState(
    [
      { id: "low", label: "Low", track: "v1", start: 5, duration: 2, priority: 1, locked: false },
      { id: "high", label: "High", track: "v1", start: 7.25, duration: 2, priority: 5, locked: false },
    ],
    { v1: ["low", "high"], v2: [] },
  );

  const result = solveTimeline(state, {});
  assert.equal(result.ok, true);
  assert.equal(result.summary.adjusted, 1);
  assert.equal(result.moves[0].id, "low");
  assert.equal(result.moves[0].toStart, 4.75);
});

test("cross-track dragging resolves only the destination track", () => {
  const state = makeState(
    [
      { id: "moving", label: "Moving", track: "v1", start: 0, duration: 2, priority: 3, locked: false },
      { id: "resident", label: "Resident", track: "v2", start: 1, duration: 2, priority: 3, locked: false },
      { id: "tail", label: "Tail", track: "v2", start: 3.5, duration: 2, priority: 2, locked: false },
    ],
    { v1: ["moving"], v2: ["resident", "tail"] },
  );

  const result = solveTimeline(state, {
    draggedId: "moving",
    targetStart: 7,
    targetTrack: "v2",
  });

  assert.equal(result.ok, true);
  assert.equal(result.positions.find((clip) => clip.id === "moving").track, "v2");
  assert.equal(result.positions.find((clip) => clip.id === "resident").start, 1);
  assert.equal(result.positions.find((clip) => clip.id === "tail").start, 3.5);
  assert.deepEqual(validateTimeline(result.positions, 0.5), []);
});

test("a locked clip cannot be dragged", () => {
  const state = makeState(
    [{ id: "locked", label: "Locked", track: "v1", start: 2, duration: 2, priority: 5, locked: true }],
    { v1: ["locked"], v2: [] },
  );
  const result = solveTimeline(state, { draggedId: "locked", targetStart: 4, targetTrack: "v1" });
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].kind, "locked-drag");
  assert.deepEqual(result.conflicts[0].clips, ["locked"]);
});
