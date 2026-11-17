/** UI wiring: controls -> render -> estimate -> validate -> plot -> export. */

import { generateSweep } from "./dsp/excitation";
import { SYSTEMS, getSystem, type SystemId } from "./dsp/systems";
import { estimate, type EstimateResult } from "./dsp/estimator";
import { validate, type ValidationResult } from "./dsp/metrics";
import { renderObservation, play } from "./audio/render";
import { encodeWav, downloadBlob, downloadText } from "./audio/wav";
import { drawFreqPlot, drawImpulsePlot, drawResidualPlot } from "./ui/plots";
import { buildTextReport, buildJsonReport, type RunRecord } from "./report";

const SAMPLE_RATE = 48000;
const IR_LENGTH = 4096;

interface Params {
  systemId: SystemId;
  sweepType: "linear" | "log";
  fStart: number;
  fEnd: number;
  durationSec: number;
  snrDb: number;
  lambda: number;
  floorDb: number;
}

interface CurrentRun {
  excitation: Float32Array;
  observation: Float32Array;
  trueIR: Float32Array;
  estimate: EstimateResult;
  validation: ValidationResult;
}

const records = new Map<SystemId, RunRecord>();
let current: CurrentRun | null = null;
let running = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function readParams(): Params {
  return {
    systemId: ($<HTMLSelectElement>("systemSelect").value as SystemId) ?? "delay",
    sweepType: $<HTMLSelectElement>("sweepType").value as "linear" | "log",
    fStart: Number($<HTMLInputElement>("fStart").value),
    fEnd: Number($<HTMLInputElement>("fEnd").value),
    durationSec: Number($<HTMLInputElement>("duration").value),
    snrDb: Number($<HTMLInputElement>("snr").value),
    lambda: Math.pow(10, Number($<HTMLInputElement>("lambda").value)),
    floorDb: Number($<HTMLInputElement>("floorDb").value),
  };
}

async function runSystem(p: Params): Promise<RunRecord> {
  const sys = getSystem(p.systemId);
  const excitation = generateSweep({
    sampleRate: SAMPLE_RATE,
    durationSec: p.durationSec,
    fStart: p.fStart,
    fEnd: Math.min(p.fEnd, SAMPLE_RATE / 2 - 1000),
    amplitude: 0.9,
    fadeSec: 0.01,
    type: p.sweepType,
  });
  const trueIR = sys.build(SAMPLE_RATE);
  const rendered = await renderObservation(excitation, trueIR, {
    sampleRate: SAMPLE_RATE,
    snrDb: p.snrDb,
    noiseSeed: 0x5eed + p.systemId.length * 7,
  });
  // The estimator receives ONLY excitation + observation.
  const est = estimate(excitation, rendered.observation, {
    sampleRate: SAMPLE_RATE,
    lambda: p.lambda,
    reliabilityFloorDb: p.floorDb,
    irLength: IR_LENGTH,
  });
  const val = validate(est, trueIR, SAMPLE_RATE);
  current = { excitation, observation: rendered.observation, trueIR, estimate: est, validation: val };
  const record: RunRecord = {
    systemId: sys.id,
    systemLabel: sys.label,
    sampleRate: SAMPLE_RATE,
    snrDb: rendered.achievedSnrDb,
    lambda: p.lambda,
    reliabilityFloorDb: p.floorDb,
    sweep: { type: p.sweepType, fStart: p.fStart, fEnd: p.fEnd, durationSec: p.durationSec },
    estimate: est,
    validation: val,
  };
  records.set(sys.id, record);
  return record;
}

function magDb(re: Float64Array, im: Float64Array): Float64Array {
  const out = new Float64Array(re.length);
  for (let k = 0; k < re.length; k++) {
    out[k] = 20 * Math.log10(Math.max(Math.hypot(re[k], im[k]), 1e-6));
  }
  return out;
}

function phaseDeg(re: Float64Array, im: Float64Array): Float64Array {
  const out = new Float64Array(re.length);
  for (let k = 0; k < re.length; k++) {
    out[k] = (Math.atan2(im[k], re[k]) * 180) / Math.PI;
  }
  return out;
}

function updatePlots(run: CurrentRun, p: Params): void {
  const est = run.estimate;
  const val = run.validation;
  const fMin = Math.max(10, p.fStart * 0.8);
  const fMax = SAMPLE_RATE / 2;
  drawFreqPlot($<HTMLCanvasElement>("magPlot"), {
    freqs: est.freqs,
    trueVals: magDb(val.trueRe, val.trueIm),
    estVals: magDb(est.hRe, est.hIm),
    reliable: est.reliable,
    fMin,
    fMax,
    yMin: -60,
    yMax: 20,
    yLabel: "dB",
    yTicks: [-60, -40, -20, 0, 20],
  });
  drawFreqPlot($<HTMLCanvasElement>("phasePlot"), {
    freqs: est.freqs,
    trueVals: phaseDeg(val.trueRe, val.trueIm),
    estVals: phaseDeg(est.hRe, est.hIm),
    reliable: est.reliable,
    fMin,
    fMax,
    yMin: -180,
    yMax: 180,
    yLabel: "deg",
    yTicks: [-180, -90, 0, 90, 180],
  });
  drawImpulsePlot($<HTMLCanvasElement>("irPlot"), {
    sampleRate: SAMPLE_RATE,
    trueIR: alignTrueIR(run.trueIR, run.estimate.bulkDelay, IR_LENGTH),
    estIR: est.impulse,
    tMaxMs: 45,
  });
  drawResidualPlot($<HTMLCanvasElement>("resPlot"), est.residual, SAMPLE_RATE);
}

/** Place the true IR at the estimator's bulk-delay offset for comparison. */
function alignTrueIR(trueIR: Float32Array, bulkDelay: number, len: number): Float64Array {
  const out = new Float64Array(len);
  for (let i = 0; i < trueIR.length && i + bulkDelay < len; i++) {
    out[i + bulkDelay] = trueIR[i];
  }
  return out;
}

function fmt(x: number, d = 2): string {
  return Number.isFinite(x) ? x.toFixed(d) : "n/a";
}

function updateMetricsBar(r: RunRecord): void {
  const v = r.validation;
  $("metricsBar").textContent =
    `系统: ${r.systemLabel}   可靠频带占比: ${(v.reliableFraction * 100).toFixed(1)}%   ` +
    `脉冲 NMSE: ${fmt(v.impulseNmseDb)} dB   复数误差 RMS: ${fmt(v.reliableComplexErr, 4)}   ` +
    `幅值误差均值: ${fmt(v.reliableMagErrDb)} dB   残差电平: ${fmt(r.estimate.residualDb)} dB`;
}

function updateCompareTable(): void {
  const tbody = document.querySelector<HTMLTableSectionElement>("#compareTable tbody")!;
  tbody.innerHTML = "";
  for (const sys of SYSTEMS) {
    const r = records.get(sys.id);
    const tr = document.createElement("tr");
    const cells = r
      ? [
          r.systemLabel,
          `${(r.validation.reliableFraction * 100).toFixed(1)}%`,
          fmt(r.validation.impulseNmseDb),
          fmt(r.validation.reliableComplexErr, 4),
          fmt(r.validation.reliableMagErrDb),
          fmt(r.estimate.residualDb),
        ]
      : [sys.label, "—", "—", "—", "—", "—"];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function setRunning(on: boolean): void {
  running = on;
  for (const id of ["runBtn", "runAllBtn", "exportEstWavBtn", "exportTrueWavBtn", "exportReportBtn"]) {
    $<HTMLButtonElement>(id).disabled = on;
  }
}

async function handleRun(all: boolean): Promise<void> {
  if (running) return;
  setRunning(true);
  try {
    const p = readParams();
    if (all) {
      for (const sys of SYSTEMS) {
        const rec = await runSystem({ ...p, systemId: sys.id });
        updateMetricsBar(rec);
        updateCompareTable();
      }
      // show plots for the currently selected system
      const rec = await runSystem(p);
      updateMetricsBar(rec);
    } else {
      const rec = await runSystem(p);
      updateMetricsBar(rec);
    }
    if (current) updatePlots(current, p);
    updateCompareTable();
  } finally {
    setRunning(false);
  }
}

function init(): void {
  const sel = $<HTMLSelectElement>("systemSelect");
  for (const s of SYSTEMS) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  const updateDesc = () => {
    $("systemDesc").textContent = getSystem(sel.value as SystemId).description;
  };
  sel.addEventListener("change", updateDesc);
  updateDesc();

  const bindRange = (id: string, outId: string, fmtFn: (v: number) => string) => {
    const el = $<HTMLInputElement>(id);
    const out = $(outId);
    const update = () => {
      out.textContent = fmtFn(Number(el.value));
    };
    el.addEventListener("input", update);
    update();
  };
  bindRange("snr", "snrVal", (v) => `${v}`);
  bindRange("lambda", "lambdaVal", (v) => `1e${v}`);
  bindRange("floorDb", "floorVal", (v) => `${v}`);

  $("runBtn").addEventListener("click", () => void handleRun(false));
  $("runAllBtn").addEventListener("click", () => void handleRun(true));
  $("playExcBtn").addEventListener("click", () => {
    if (current) play(current.excitation, SAMPLE_RATE);
  });
  $("playObsBtn").addEventListener("click", () => {
    if (current) play(current.observation, SAMPLE_RATE);
  });
  $("exportEstWavBtn").addEventListener("click", () => {
    if (!current) return;
    downloadBlob(encodeWav(current.estimate.impulse, SAMPLE_RATE), "estimated-impulse-response.wav");
  });
  $("exportTrueWavBtn").addEventListener("click", () => {
    if (!current) return;
    downloadBlob(encodeWav(current.trueIR, SAMPLE_RATE), "true-impulse-response.wav");
  });
  $("exportReportBtn").addEventListener("click", () => {
    const runs = SYSTEMS.map((s) => records.get(s.id)).filter((r): r is RunRecord => !!r);
    if (runs.length === 0) return;
    downloadText(buildTextReport(runs), "sysid-error-report.txt");
    downloadText(buildJsonReport(runs), "sysid-error-report.json", "application/json");
  });
  updateCompareTable();
}

init();
