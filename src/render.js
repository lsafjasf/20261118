const COLORS = {
  bg: "#08131d",
  panel: "#0b1925",
  line: "rgba(137, 177, 208, 0.16)",
  lineStrong: "rgba(137, 177, 208, 0.28)",
  text: "#e7f1f8",
  muted: "#89a2b7",
  faint: "#5d7589",
  cyan: "#7dd7ef",
  blue: "#386f94",
  blueLight: "#4b86aa",
  amber: "#ffb05c",
  amberLight: "#ffd29c",
  amberDark: "#5a3717",
  green: "#70dbb2",
  red: "#ff766f"
};

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, r);
}

function timeLabel(seconds) {
  return `${Number(seconds).toFixed(0)}s`;
}

export function drawTimeline(canvas, model, currentTime = 0) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const left = 70;
  const right = width - 34;
  const trackWidth = right - left;
  const mapTime = time => left + (Math.max(0, Math.min(time, model.totalDuration)) / model.totalDuration) * trackWidth;

  context.clearRect(0, 0, width, height);
  context.fillStyle = COLORS.bg;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(125, 215, 239, 0.035)";
  for (let x = left; x < right; x += 20) context.fillRect(x, 26, 1, 260);
  for (let y = 26; y < 286; y += 20) context.fillRect(left, y, trackWidth, 1);

  context.fillStyle = COLORS.faint;
  context.font = '600 9px "DejaVu Sans Mono", monospace';
  context.fillText("MEDIA TIME / VOD", 19, 24);
  context.fillText("48.00s", right - 38, 24);

  for (let second = 0; second <= model.totalDuration; second += 3) {
    const x = mapTime(second);
    const major = second % 6 === 0;
    context.strokeStyle = major ? COLORS.lineStrong : COLORS.line;
    context.beginPath();
    context.moveTo(x + 0.5, 38);
    context.lineTo(x + 0.5, major ? 62 : 54);
    context.stroke();
    if (major) {
      context.fillStyle = COLORS.muted;
      context.font = '9px "DejaVu Sans Mono", monospace';
      context.fillText(timeLabel(second), x - 9, 35);
    }
  }

  context.fillStyle = COLORS.faint;
  context.font = '600 9px "DejaVu Sans Mono", monospace';
  context.fillText("FRAGMENTS", 19, 98);
  const segmentGap = 2;
  const segmentWidth = trackWidth / model.segments.length;
  for (const segment of model.segments) {
    const cue = model.cues.find(
      item => segment.start >= item.start - 0.001 && segment.start < item.end - 0.001
    );
    const x = mapTime(segment.start) + segmentGap / 2;
    const w = segmentWidth - segmentGap;
    roundedRect(context, x, 72, w, 38, 4);
    context.fillStyle = cue ? COLORS.amberDark : "rgba(56, 111, 148, 0.42)";
    context.fill();
    context.strokeStyle = cue ? "rgba(255, 176, 92, 0.5)" : "rgba(107, 175, 215, 0.32)";
    context.stroke();
    context.fillStyle = cue ? COLORS.amberLight : "#a7cbe2";
    context.font = '600 9px "DejaVu Sans Mono", monospace';
    context.textAlign = "center";
    context.fillText(String(segment.index).padStart(2, "0"), x + w / 2, 96);
    context.textAlign = "left";
  }

  const laneY = [139, 190, 241];
  model.cues.forEach((cue, index) => {
    const y = laneY[index] || 139 + index * 50;
    const x1 = mapTime(cue.start);
    const x2 = mapTime(cue.end);
    const barrier = Math.max(4, x2 - x1);
    context.strokeStyle = "rgba(137, 177, 208, 0.1)";
    context.beginPath();
    context.moveTo(left, y + 18.5);
    context.lineTo(right, y + 18.5);
    context.stroke();

    context.fillStyle = COLORS.muted;
    context.font = '600 9px "DejaVu Sans Mono", monospace';
    context.fillText(cue.id.toUpperCase(), 19, y + 13);
    context.fillStyle = COLORS.faint;
    context.font = '8px "DejaVu Sans Mono", monospace';
    context.fillText(cue.kind === "pre-roll" ? "PRE" : "MID", 19, y + 27);

    roundedRect(context, x1, y, barrier, 25, 5);
    const gradient = context.createLinearGradient(x1, y, x2, y + 25);
    gradient.addColorStop(0, cue.status === "warning" ? "#9d6229" : "#8a5122");
    gradient.addColorStop(1, cue.status === "warning" ? "#6c411d" : "#553315");
    context.fillStyle = gradient;
    context.fill();
    context.strokeStyle = cue.status === "warning" ? COLORS.amber : "rgba(255, 176, 92, 0.5)";
    context.stroke();

    context.fillStyle = COLORS.amberLight;
    context.font = '600 9px "DejaVu Sans Mono", monospace';
    context.fillText(cue.id.toUpperCase(), x1 + 9, y + 16);
    const labelWidth = context.measureText(cue.id.toUpperCase()).width;
    context.fillStyle = "rgba(255, 226, 191, 0.76)";
    context.font = '8px "DejaVu Sans Mono", monospace';
    if (barrier > 180) {
      context.fillText(
        `${cue.start.toFixed(2)} → ${cue.end.toFixed(2)}s  /  ${cue.actualDuration.toFixed(2)}s`,
        x1 + 14 + labelWidth,
        y + 16
      );
    }

    if (cue.declaredEnd != null && Math.abs(cue.declaredEnd - cue.end) > 0.05) {
      const ghostEnd = mapTime(cue.declaredEnd);
      context.save();
      context.setLineDash([4, 4]);
      context.strokeStyle = "rgba(255, 176, 92, 0.55)";
      context.beginPath();
      context.moveTo(x2, y + 12.5);
      context.lineTo(ghostEnd, y + 12.5);
      context.stroke();
      context.restore();
      context.fillStyle = COLORS.amber;
      context.font = '8px "DejaVu Sans Mono", monospace';
      context.fillText(`DECLARED END ${cue.declaredEnd.toFixed(0)}s`, ghostEnd - 78, y + 38);
    }

    for (const continuity of cue.continuity) {
      const cx = mapTime(continuity.time);
      context.fillStyle = "rgba(255, 220, 185, 0.78)";
      context.beginPath();
      context.arc(cx, y + 12.5, 2.1, 0, Math.PI * 2);
      context.fill();
    }

    const markerX = x2;
    context.fillStyle = cue.status === "warning" ? COLORS.amber : COLORS.green;
    context.beginPath();
    context.moveTo(markerX, y - 4);
    context.lineTo(markerX - 4, y - 10);
    context.lineTo(markerX + 4, y - 10);
    context.closePath();
    context.fill();
    context.font = '700 8px "DejaVu Sans Mono", monospace';
    context.fillText(`IN #${String(cue.returnSegmentIndex).padStart(2, "0")}`, markerX + 6, y - 5);
  });

  const playX = mapTime(currentTime);
  context.strokeStyle = "rgba(255, 118, 111, 0.9)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(playX, 52);
  context.lineTo(playX, 274);
  context.stroke();
  context.lineWidth = 1;
  context.fillStyle = COLORS.red;
  context.beginPath();
  context.moveTo(playX - 5, 52);
  context.lineTo(playX + 5, 52);
  context.lineTo(playX, 60);
  context.closePath();
  context.fill();
  context.font = '700 8px "DejaVu Sans Mono", monospace';
  context.fillText(`PLAY ${currentTime.toFixed(2)}s`, playX + 7, 66);

  context.strokeStyle = COLORS.line;
  context.beginPath();
  context.moveTo(left, 286.5);
  context.lineTo(right, 286.5);
  context.stroke();
  context.fillStyle = COLORS.faint;
  context.font = '8px "DejaVu Sans Mono", monospace';
  context.fillText("DOTS = CUE-OUT-CONT", left, 303);
  context.fillText("DASHED = DECLARED END", left + 170, 303);
  context.textAlign = "right";
  context.fillText(
    `${model.summary.cueCount} CUES · ${model.summary.adDuration.toFixed(2)}s AD · ` +
      `${model.summary.contentDuration.toFixed(2)}s CONTENT`,
    right,
    303
  );
  context.textAlign = "left";
}
