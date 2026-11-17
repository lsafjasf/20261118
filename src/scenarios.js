const TRACKS = [
  { id: "v1", label: "V1", name: "主画面" },
  { id: "v2", label: "V2", name: "叠加层" },
  { id: "a1", label: "A1", name: "声音" },
];

function state({ clips, orders, precedence = [], minGap = 0.5 }) {
  return {
    minGap,
    tracks: structuredClone(TRACKS),
    clips,
    orders,
    precedence,
  };
}

const shiftState = state({
  clips: [
    { id: "intro", label: "Intro", track: "v1", start: 0, duration: 3, priority: 4, locked: false, tone: "cyan" },
    { id: "build", label: "Build", track: "v1", start: 3.5, duration: 3, priority: 2, locked: false, tone: "cyan" },
    { id: "drop", label: "Drop", track: "v1", start: 7, duration: 3, priority: 3, locked: false, tone: "cyan" },
    { id: "outro", label: "Outro", track: "v1", start: 10.5, duration: 3, priority: 2, locked: false, tone: "cyan" },
    { id: "overlay", label: "Overlay", track: "v2", start: 1.5, duration: 3, priority: 3, locked: false, tone: "violet" },
    { id: "title", label: "Title", track: "v2", start: 8, duration: 4, priority: 5, locked: false, tone: "violet" },
    { id: "music", label: "Music bed", track: "a1", start: 0, duration: 14, priority: 1, locked: true, tone: "amber" },
  ],
  orders: {
    v1: ["intro", "build", "drop", "outro"],
    v2: ["overlay", "title"],
    a1: ["music"],
  },
});

const cycleState = state({
  clips: [
    { id: "cycle-a", label: "Cycle A", track: "v1", start: 0, duration: 2, priority: 3, locked: false, tone: "cyan" },
    { id: "cycle-b", label: "Cycle B", track: "v1", start: 2.5, duration: 2, priority: 3, locked: false, tone: "cyan" },
    { id: "cycle-c", label: "Cycle C", track: "v1", start: 5, duration: 2, priority: 3, locked: false, tone: "cyan" },
    { id: "cycle-bed", label: "Guide", track: "a1", start: 0, duration: 8, priority: 1, locked: false, tone: "amber" },
  ],
  orders: {
    v1: ["cycle-a", "cycle-b", "cycle-c"],
    v2: [],
    a1: ["cycle-bed"],
  },
  precedence: [
    { before: "cycle-a", after: "cycle-b" },
    { before: "cycle-b", after: "cycle-c" },
    { before: "cycle-c", after: "cycle-a" },
  ],
});

const lockOverlapState = state({
  clips: [
    { id: "lock-a", label: "Lock A", track: "v1", start: 2, duration: 3, priority: 5, locked: true, tone: "cyan" },
    { id: "lock-b", label: "Lock B", track: "v1", start: 5.2, duration: 2.5, priority: 4, locked: true, tone: "cyan" },
    { id: "lock-bed", label: "Guide", track: "a1", start: 1, duration: 8, priority: 1, locked: false, tone: "amber" },
  ],
  orders: {
    v1: ["lock-a", "lock-b"],
    v2: [],
    a1: ["lock-bed"],
  },
});

const dragLockState = state({
  clips: [
    { id: "drag-d", label: "Drag D", track: "v1", start: 10, duration: 2.5, priority: 5, locked: false, tone: "cyan" },
    { id: "drag-lock", label: "Lock L", track: "v1", start: 6, duration: 4.5, priority: 5, locked: true, tone: "cyan" },
    { id: "drag-overlay", label: "Parallel", track: "v2", start: 3, duration: 4, priority: 2, locked: false, tone: "violet" },
  ],
  orders: {
    v1: ["drag-lock", "drag-d"],
    v2: ["drag-overlay"],
    a1: [],
  },
});

export const SCENARIOS = [
  {
    id: "shift",
    number: "01",
    act: "解算成功",
    title: "整体后移",
    subtitle: "拖动 Intro 至 2.0s，V1 下游片段整体让位；V2 / A1 保持并行。",
    tone: "success",
    state: shiftState,
    request: { draggedId: "intro", targetStart: 2, targetTrack: "v1" },
  },
  {
    id: "cycle",
    number: "02",
    act: "无解 · 循环",
    title: "循环约束",
    subtitle: "A → B → C → A 同时要求三段先后顺序，拒绝应用任何移动。",
    tone: "danger",
    state: cycleState,
    request: { draggedId: "cycle-a", targetStart: 1, targetTrack: "v1" },
  },
  {
    id: "locked-overlap",
    number: "03",
    act: "无解 · 锁定",
    title: "锁定重叠",
    subtitle: "两段均已锁定，但 0.2s 的实际空隙小于 0.5s 最小空隙。",
    tone: "danger",
    state: lockOverlapState,
    request: null,
  },
  {
    id: "drag-locked",
    number: "04",
    act: "无解 · 锚点",
    title: "目标被锁",
    subtitle: "拖动目标与锁定片段冲突，定位冲突双方而非偷偷重叠。",
    tone: "danger",
    state: dragLockState,
    request: { draggedId: "drag-d", targetStart: 4, targetTrack: "v1" },
  },
];

export function getScenario(id) {
  const scenario = SCENARIOS.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);
  return {
    ...scenario,
    state: structuredClone(scenario.state),
    request: scenario.request ? { ...scenario.request } : null,
  };
}
