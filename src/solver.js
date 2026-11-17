const EPSILON = 1e-7;

const round = (value) => Math.round(value * 1000) / 1000;
const same = (a, b) => Math.abs(a - b) <= EPSILON;

function clipMapOf(clips) {
  return new Map(clips.map((clip) => [clip.id, clip]));
}

function trackClips(clips, trackId) {
  return clips.filter((clip) => clip.track === trackId);
}

function findCycle(precedence, knownIds) {
  const adjacency = new Map();
  for (const id of knownIds) adjacency.set(id, []);

  for (const edge of precedence) {
    if (!adjacency.has(edge.before) || !adjacency.has(edge.after)) continue;
    adjacency.get(edge.before).push(edge.after);
  }

  const state = new Map();
  const stack = [];

  function visit(id) {
    state.set(id, 1);
    stack.push(id);

    for (const next of adjacency.get(id) || []) {
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      } else if (state.get(next) === 1) {
        const index = stack.indexOf(next);
        return [...stack.slice(index), next];
      }
    }

    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const id of knownIds) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

function cycleConflict(cycle, clips) {
  const byId = clipMapOf(clips);
  const unique = [...new Set(cycle)];
  const labels = cycle.map((id) => byId.get(id)?.label || id);
  return {
    kind: "cycle",
    clips: unique,
    message: `硬性先后约束形成环：${labels.join(" → ")}`,
  };
}

function proposedOrders(state, dragged) {
  const orders = {};
  for (const track of state.tracks) {
    const known = new Set(trackClips(state.clips, track.id).map((clip) => clip.id));
    const ordered = (state.orders?.[track.id] || []).filter((id) => known.has(id));
    const seen = new Set(ordered);
    const missing = state.clips
      .filter((clip) => clip.track === track.id && !seen.has(clip.id))
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    orders[track.id] = [...ordered, ...missing.map((clip) => clip.id)];
  }

  if (!dragged) return orders;

  for (const track of Object.keys(orders)) {
    orders[track] = orders[track].filter((id) => id !== dragged.id);
  }

  const targetOrder = orders[dragged.targetTrack] || [];
  const byId = clipMapOf(state.clips);
  const targetCenter = dragged.targetStart + byId.get(dragged.id).duration / 2;
  let insertAt = targetOrder.length;
  for (let index = 0; index < targetOrder.length; index += 1) {
    const clip = byId.get(targetOrder[index]);
    if (clip.start + clip.duration / 2 > targetCenter) {
      insertAt = index;
      break;
    }
  }
  targetOrder.splice(insertAt, 0, dragged.id);
  orders[dragged.targetTrack] = targetOrder;
  return orders;
}

function pairSpan(order, fromIndex, toIndex, byId, minGap) {
  let span = 0;
  for (let index = fromIndex; index < toIndex; index += 1) {
    span += byId.get(order[index]).duration + minGap;
  }
  return span;
}

function compatible(lastIndex, nextIndex, order, positions, byId, minGap) {
  if (lastIndex < 0) {
    const prefix = pairSpan(order, 0, nextIndex, byId, minGap);
    return positions[nextIndex] >= prefix - EPSILON;
  }
  const required = pairSpan(order, lastIndex, nextIndex, byId, minGap);
  return positions[nextIndex] - positions[lastIndex] >= required - EPSILON;
}

function findConflict(order, fixedIndices, positions, byId, minGap, draggedId) {
  if (fixedIndices.length) {
    const first = fixedIndices[0];
    const prefix = pairSpan(order, 0, first, byId, minGap);
    if (positions[first] < prefix - EPSILON) {
      return {
        kind: "timeline-start",
        clips: [order[0], order[first]],
        track: byId.get(order[first]).track,
        required: round(prefix),
        available: round(positions[first]),
        message: `${byId.get(order[first]).label} 之前的片段无法放入 0s 起点之前：至少需要 ${round(prefix)}s 的空间。`,
      };
    }
  }

  for (let index = 1; index < fixedIndices.length; index += 1) {
    const left = fixedIndices[index - 1];
    const right = fixedIndices[index];
    const required = pairSpan(order, left, right, byId, minGap);
    const available = positions[right] - positions[left];
    if (available < required - EPSILON) {
      const leftClip = byId.get(order[left]);
      const rightClip = byId.get(order[right]);
      const involvesDrag = leftClip.id === draggedId || rightClip.id === draggedId;
      return {
        kind: involvesDrag ? "drag-locked" : "locked-collision",
        clips: [leftClip.id, rightClip.id],
        track: leftClip.track,
        required: round(required),
        available: round(available),
        message: involvesDrag
          ? `${leftClip.label} 与 ${rightClip.label} 的拖动目标被锁定位置阻断：至少需要 ${round(required)}s，当前只有 ${round(available)}s。`
          : `${leftClip.label} 与 ${rightClip.label} 的最小空隙无法满足：至少需要 ${round(required)}s，当前只有 ${round(available)}s。`,
      };
    }
  }
  return null;
}

function chooseKept(order, mandatory, positions, byId, minGap) {
  const memo = new Map();

  function search(index, lastIndex) {
    if (index === order.length) {
      return { count: 0, priority: 0, selected: [] };
    }

    const key = `${index}:${lastIndex}`;
    if (memo.has(key)) return memo.get(key);

    const isMandatory = mandatory.has(index);
    const canKeep = compatible(lastIndex, index, order, positions, byId, minGap);

    let best = null;
    if (canKeep) {
      const suffix = search(index + 1, index);
      if (suffix) {
        const clip = byId.get(order[index]);
        best = {
          count: suffix.count + 1,
          priority: suffix.priority + clip.priority,
          selected: [index, ...suffix.selected],
        };
      }
    }

    if (!isMandatory) {
      const suffix = search(index + 1, lastIndex);
      if (
        suffix &&
        (!best ||
          suffix.count > best.count ||
          (suffix.count === best.count && suffix.priority > best.priority))
      ) {
        best = suffix;
      }
    }

    memo.set(key, best);
    return best;
  }

  return search(0, -1);
}

function assignTrack(order, keptIndices, fixedPositions, byId, minGap) {
  const positions = new Map();
  const fixed = [...keptIndices].sort((a, b) => a - b);
  for (const index of fixed) positions.set(index, fixedPositions.get(index));

  if (fixed.length === 0) {
    let cursor = order.length ? byId.get(order[0]).start : 0;
    for (let index = 0; index < order.length; index += 1) {
      positions.set(index, round(cursor));
      cursor += byId.get(order[index]).duration + minGap;
    }
    return positions;
  }

  const first = fixed[0];
  let cursor = fixedPositions.get(first);
  for (let index = first - 1; index >= 0; index -= 1) {
    cursor -= byId.get(order[index]).duration + minGap;
    positions.set(index, cursor);
  }

  for (let segment = 1; segment < fixed.length; segment += 1) {
    const left = fixed[segment - 1];
    const right = fixed[segment];
    const moved = [];
    for (let index = left + 1; index < right; index += 1) moved.push(index);
    if (moved.length === 0) continue;

    const leftPacked = new Map();
    let leftCursor = fixedPositions.get(left) + byId.get(order[left]).duration + minGap;
    for (const index of moved) {
      leftPacked.set(index, leftCursor);
      leftCursor += byId.get(order[index]).duration + minGap;
    }

    const rightPacked = new Map();
    let rightCursor = fixedPositions.get(right);
    for (let index = right - 1; index > left; index -= 1) {
      rightCursor -= byId.get(order[index]).duration + minGap;
      rightPacked.set(index, rightCursor);
    }

    const distance = (packed) =>
      moved.reduce(
        (total, index) =>
          total + Math.abs(packed.get(index) - byId.get(order[index]).start),
        0,
      );
    const chosen = distance(leftPacked) <= distance(rightPacked) ? leftPacked : rightPacked;
    for (const index of moved) positions.set(index, chosen.get(index));
  }

  const last = fixed[fixed.length - 1];
  cursor = fixedPositions.get(last) + byId.get(order[last]).duration + minGap;
  for (let index = last + 1; index < order.length; index += 1) {
    positions.set(index, cursor);
    cursor += byId.get(order[index]).duration + minGap;
  }

  return positions;
}

function rejected(state, conflicts, minGap) {
  return {
    ok: false,
    conflicts,
    moves: [],
    positions: state.clips.map((clip) => ({ ...clip })),
    orders: structuredClone(state.orders || {}),
    summary: {
      minGap,
      totalMoved: 0,
      adjusted: 0,
      kept: state.clips.length,
      conflictCount: conflicts.length,
    },
  };
}

export function solveTimeline(state, request = {}) {
  const minGap = Number.isFinite(request.minGap)
    ? Math.max(0, request.minGap)
    : Math.max(0, Number(state.minGap) || 0);
  const byId = clipMapOf(state.clips);
  const draggedClip = request.draggedId ? byId.get(request.draggedId) : null;

  const cycle = findCycle(state.precedence || [], [...byId.keys()]);
  if (cycle) {
    return rejected(state, [cycleConflict(cycle, state.clips)], minGap);
  }

  if (request.draggedId && !draggedClip) {
    return rejected(
      state,
      [{ kind: "invalid", clips: [request.draggedId], message: "找不到被拖动的片段。" }],
      minGap,
    );
  }

  if (draggedClip?.locked) {
    return rejected(
      state,
      [
        {
          kind: "locked-drag",
          clips: [draggedClip.id],
          message: `${draggedClip.label} 已锁定，解除锁定后才能拖动。`,
        },
      ],
      minGap,
    );
  }

  const dragged = draggedClip
    ? {
        id: draggedClip.id,
        targetTrack: request.targetTrack || draggedClip.track,
        targetStart: Math.max(0, Number(request.targetStart) || 0),
      }
    : null;
  if (dragged && !state.tracks.some((track) => track.id === dragged.targetTrack)) {
    return rejected(
      state,
      [{ kind: "invalid", clips: [dragged.id], message: "目标轨道不存在。" }],
      minGap,
    );
  }

  const orders = proposedOrders(state, dragged);
  if (dragged) {
    const targetOrder = orders[dragged.targetTrack];
    const draggedIndex = targetOrder.indexOf(dragged.id);
    const prefix = pairSpan(targetOrder, 0, draggedIndex, byId, minGap);
    if (dragged.targetStart < prefix - EPSILON) {
      dragged.targetStart = round(prefix);
    }
  }

  const orderConflicts = [];
  for (const constraint of state.precedence || []) {
    const before = byId.get(constraint.before);
    const after = byId.get(constraint.after);
    if (!before || !after) {
      orderConflicts.push({
        kind: "order",
        clips: [constraint.before, constraint.after],
        message: "硬性先后约束引用了不存在的片段。",
      });
      continue;
    }
    const beforeTrack = before.id === dragged?.id ? dragged.targetTrack : before.track;
    const afterTrack = after.id === dragged?.id ? dragged.targetTrack : after.track;
    const order = orders[beforeTrack] || [];
    if (beforeTrack !== afterTrack || order.indexOf(before.id) >= order.indexOf(after.id)) {
      orderConflicts.push({
        kind: "order",
        clips: [before.id, after.id],
        track: beforeTrack,
        message: `${before.label} 必须位于 ${after.label} 之前，但拖动后的轨道顺序相反。`,
      });
    }
  }
  if (orderConflicts.length) return rejected(state, orderConflicts, minGap);

  const conflicts = [];
  const solvedPositions = new Map();
  const solvedOrders = {};

  for (const track of state.tracks) {
    const order = orders[track.id] || [];
    if (order.length === 0) {
      solvedOrders[track.id] = order;
      continue;
    }

    const positions = order.map((id) => {
      const clip = byId.get(id);
      if (id === dragged?.id) return round(dragged.targetStart);
      return round(clip.start);
    });
    const mandatory = new Map();

    order.forEach((id, index) => {
      const clip = byId.get(id);
      if (clip.locked || id === dragged?.id) mandatory.set(index, positions[index]);
    });

    const mandatoryIndices = [...mandatory.keys()].sort((a, b) => a - b);
    const conflict = findConflict(
      order,
      mandatoryIndices,
      positions,
      byId,
      minGap,
      dragged?.id,
    );
    if (conflict) {
      conflicts.push(conflict);
      continue;
    }

    const selection = chooseKept(order, new Set(mandatoryIndices), positions, byId, minGap);
    const fixedPositions = new Map();
    for (const index of selection.selected) fixedPositions.set(index, positions[index]);
    const assigned = assignTrack(order, selection.selected, fixedPositions, byId, minGap);

    order.forEach((id, index) => {
      solvedPositions.set(id, {
        start: round(assigned.get(index) ?? positions[index]),
        track: track.id,
      });
    });
    solvedOrders[track.id] = order;
  }

  if (conflicts.length) return rejected(state, conflicts, minGap);

  const finalClips = state.clips.map((clip) => {
    const solved = solvedPositions.get(clip.id);
    return solved
      ? { ...clip, start: solved.start, track: solved.track }
      : { ...clip };
  });

  const moves = [];
  for (const before of state.clips) {
    const after = finalClips.find((clip) => clip.id === before.id);
    const movedTrack = after.track !== before.track;
    const movedTime = !same(after.start, before.start);
    if (!movedTrack && !movedTime) continue;

    const isDragged = before.id === dragged?.id;
    let reason = isDragged ? "拖动锚点" : movedTime && after.start > before.start ? "后移避让" : "前移避让";
    if (movedTrack) reason = isDragged ? "跨轨拖动" : "跨轨磁吸";

    moves.push({
      id: before.id,
      label: before.label,
      fromTrack: before.track,
      toTrack: after.track,
      fromStart: before.start,
      toStart: after.start,
      delta: round(after.start - before.start),
      reason,
      priority: before.priority,
      locked: before.locked,
      userMoved: isDragged,
    });
  }

  const adjustedMoves = moves.filter((move) => !move.userMoved);
  return {
    ok: true,
    conflicts: [],
    moves,
    positions: finalClips,
    orders: solvedOrders,
    summary: {
      minGap,
      totalMoved: moves.length,
      adjusted: adjustedMoves.length,
      kept: state.clips.length - moves.length,
      conflictCount: 0,
      tracksTouched: [...new Set(moves.map((move) => move.toTrack))].length,
    },
  };
}

export function validateTimeline(clips, minGap = 0) {
  const problems = [];
  const byTrack = new Map();
  for (const clip of clips) {
    if (!byTrack.has(clip.track)) byTrack.set(clip.track, []);
    byTrack.get(clip.track).push(clip);
  }

  for (const [track, trackItems] of byTrack) {
    const sorted = [...trackItems].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const gap = current.start - (previous.start + previous.duration);
      if (gap < minGap - EPSILON) {
        problems.push({
          track,
          clips: [previous.id, current.id],
          gap: round(gap),
          required: minGap,
        });
      }
    }
  }
  return problems;
}
