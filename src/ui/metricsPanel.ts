import type { FrameMetrics, SequenceMetrics } from '../metrics/metrics';

function fmt(v: number, digits = 2): string {
  return v.toFixed(digits);
}

export function renderMetrics(
  container: HTMLElement,
  seq: SequenceMetrics,
  frameIndex: number
): void {
  const frame: FrameMetrics = seq.perFrame[frameIndex];
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgEdge = avg(seq.perFrame.map((m) => m.edgeMAE));
  const avgColor = avg(seq.perFrame.map((m) => m.colorShift));

  container.innerHTML = `
    <div class="metric"><b>${fmt(frame.alphaMAE)}</b><span>本帧遮罩 MAE</span></div>
    <div class="metric"><b>${fmt(frame.alphaRMSE)}</b><span>本帧遮罩 RMSE</span></div>
    <div class="metric"><b>${fmt(frame.edgeMAE)}</b><span>本帧边缘误差</span></div>
    <div class="metric"><b>${fmt(avgEdge)}</b><span>全序列平均边缘误差</span></div>
    <div class="metric"><b>${fmt(frame.colorShift)}</b><span>本帧前景颜色偏移</span></div>
    <div class="metric"><b>${fmt(avgColor)}</b><span>全序列平均颜色偏移</span></div>
    <div class="metric"><b>${fmt(seq.temporalJitter)}</b><span>连续帧抖动</span></div>
    <div class="metric"><b>${fmt(seq.ambiguityRecall * 100, 1)}%</b><span>歧义召回率</span></div>
  `;
}
