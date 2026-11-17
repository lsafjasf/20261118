/**
 * Web Audio layer: the "unknown system" is an OfflineAudioContext graph
 * (ConvolverNode + controllable noise). The estimator never touches this;
 * it only receives the excitation buffer and the rendered observation.
 */

import { convolve } from "../dsp/fft";
import { generateNoise, rms } from "../dsp/excitation";

export interface RenderOptions {
  sampleRate: number;
  /** Target SNR in dB (clean convolved signal vs additive noise). */
  snrDb: number;
  noiseSeed: number;
}

export interface RenderResult {
  observation: Float32Array;
  clean: Float32Array;
  noise: Float32Array;
  achievedSnrDb: number;
}

/** Render excitation -> hidden FIR -> +noise inside an OfflineAudioContext. */
export async function renderObservation(
  excitation: Float32Array,
  systemIR: Float32Array,
  opts: RenderOptions,
): Promise<RenderResult> {
  const sr = opts.sampleRate;
  const clean = convolve(excitation, systemIR);
  const cleanLen = clean.length;
  const noise = generateNoise(cleanLen, opts.noiseSeed);
  const cleanRms = rms(clean);
  const noiseRmsTarget = cleanRms * Math.pow(10, -opts.snrDb / 20);
  const noiseGain = noiseRmsTarget / Math.max(rms(noise), 1e-12);
  const ctx = new OfflineAudioContext(1, cleanLen, sr);
  const xBuf = ctx.createBuffer(1, excitation.length, sr);
  xBuf.copyToChannel(excitation as Float32Array<ArrayBuffer>, 0);
  const irBuf = ctx.createBuffer(1, systemIR.length, sr);
  irBuf.copyToChannel(systemIR as Float32Array<ArrayBuffer>, 0);
  const nBuf = ctx.createBuffer(1, cleanLen, sr);
  nBuf.copyToChannel(noise as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = xBuf;
  const conv = ctx.createConvolver();
  conv.buffer = irBuf;
  conv.normalize = false;
  src.connect(conv).connect(ctx.destination);
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = nBuf;
  const nGain = ctx.createGain();
  nGain.gain.value = noiseGain;
  nSrc.connect(nGain).connect(ctx.destination);
  src.start(0);
  nSrc.start(0);
  const rendered = await ctx.startRendering();
  const observation = rendered.getChannelData(0).slice();
  const scaledNoise = new Float32Array(cleanLen);
  for (let i = 0; i < cleanLen; i++) scaledNoise[i] = noise[i] * noiseGain;
  const achievedSnrDb =
    20 * Math.log10(Math.max(rms(clean), 1e-12) / Math.max(rms(scaledNoise), 1e-12));
  return { observation, clean: Float32Array.from(clean), noise: scaledNoise, achievedSnrDb };
}

let playCtx: AudioContext | null = null;

/** Play a mono signal through the default output. */
export function play(signal: Float32Array, sampleRate: number, gain = 0.8): void {
  if (!playCtx) playCtx = new AudioContext({ sampleRate });
  void playCtx.resume();
  const buf = playCtx.createBuffer(1, signal.length, sampleRate);
  let peak = 0;
  for (let i = 0; i < signal.length; i++) peak = Math.max(peak, Math.abs(signal[i]));
  const g = peak > 1e-9 ? gain / peak : gain;
  const ch = buf.getChannelData(0);
  for (let i = 0; i < signal.length; i++) ch[i] = signal[i] * g;
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  src.start();
}
