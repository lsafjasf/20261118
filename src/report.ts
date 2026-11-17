/** Error report generation (plain text + JSON). */

import type { EstimateResult } from "./dsp/estimator";
import type { ValidationResult } from "./dsp/metrics";

export interface RunRecord {
  systemId: string;
  systemLabel: string;
  sampleRate: number;
  snrDb: number;
  lambda: number;
  reliabilityFloorDb: number;
  sweep: { type: "linear" | "log"; fStart: number; fEnd: number; durationSec: number };
  estimate: EstimateResult;
  validation: ValidationResult;
}

function fmt(x: number, digits = 2): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "  n/a";
}

export function buildTextReport(runs: RunRecord[]): string {
  const lines: string[] = [];
  lines.push("声学系统辨识实验台 — 误差报告");
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push("估计器仅使用激励 x 与观测 y；真实响应仅用于事后对比。");
  lines.push("");
  for (const r of runs) {
    const v = r.validation;
    const e = r.estimate;
    lines.push(`=== 系统: ${r.systemLabel} (${r.systemId}) ===`);
    lines.push(
      `  扫频 ${r.sweep.type} ${r.sweep.fStart}-${r.sweep.fEnd} Hz / ${r.sweep.durationSec}s` +
        ` @ ${r.sampleRate} Hz, SNR=${r.snrDb} dB, λ=${r.lambda},` +
        ` 可靠性门限=${r.reliabilityFloorDb} dB`,
    );
    lines.push(`  可靠频带占比:        ${(v.reliableFraction * 100).toFixed(1)} %`);
    lines.push(`  脉冲响应 NMSE:       ${fmt(v.impulseNmseDb)} dB`);
    lines.push(`  可靠频带复数误差 RMS: ${fmt(v.reliableComplexErr, 4)}`);
    lines.push(`  可靠频带幅值误差均值: ${fmt(v.reliableMagErrDb)} dB`);
    lines.push(`  重建残差电平:        ${fmt(e.residualDb)} dB (相对观测)`);
    lines.push("  分频段误差 (仅统计可靠频点):");
    lines.push("    频段(Hz)        复数误差RMS  幅值误差dB  可靠频点");
    for (const b of v.bands) {
      lines.push(
        `    ${String(Math.round(b.fLow)).padStart(6)}-${String(Math.round(b.fHigh)).padEnd(6)}` +
          `  ${fmt(b.complexErr, 4).padStart(10)}  ${fmt(b.magErrDb).padStart(10)}  ` +
          `${b.reliableBins}/${b.totalBins}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildJsonReport(runs: RunRecord[]): string {
  const data = runs.map((r) => ({
    system: { id: r.systemId, label: r.systemLabel },
    config: {
      sampleRate: r.sampleRate,
      snrDb: r.snrDb,
      lambda: r.lambda,
      reliabilityFloorDb: r.reliabilityFloorDb,
      sweep: r.sweep,
    },
    metrics: {
      reliableFraction: r.validation.reliableFraction,
      impulseNmseDb: r.validation.impulseNmseDb,
      reliableComplexErr: r.validation.reliableComplexErr,
      reliableMagErrDb: r.validation.reliableMagErrDb,
      residualDb: r.estimate.residualDb,
      bands: r.validation.bands,
    },
  }));
  return JSON.stringify({ generatedAt: new Date().toISOString(), runs: data }, null, 2);
}
