/**
 * Known ground-truth FIR systems. These are hidden from the estimator:
 * the estimator only ever sees the excitation and the observed output.
 */

export type SystemId = "delay" | "echo" | "notch";

export interface SystemDef {
  id: SystemId;
  label: string;
  description: string;
  /** Build the FIR impulse response at the given sample rate. */
  build: (sampleRate: number) => Float32Array;
}

function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

export const SYSTEMS: SystemDef[] = [
  {
    id: "delay",
    label: "纯延迟 (Pure Delay)",
    description: "h[n] = 0.8·δ(n − 12ms)，全通幅频 + 线性相位",
    build: (sr) => {
      const d = msToSamples(12, sr);
      const h = new Float32Array(d + 1);
      h[d] = 0.8;
      return h;
    },
  },
  {
    id: "echo",
    label: "双反射 (Double Reflection)",
    description: "直达声 + 8ms/21ms 两次衰减反射，幅频呈梳状",
    build: (sr) => {
      const d1 = msToSamples(8, sr);
      const d2 = msToSamples(21, sr);
      const h = new Float32Array(d2 + 1);
      h[0] = 1.0;
      h[d1] = 0.55;
      h[d2] = -0.35;
      return h;
    },
  },
  {
    id: "notch",
    label: "深陷波 (Deep Notch)",
    description: "2.4kHz 双零点陷波（陷波深度约 −46dB）+ 5ms 延迟",
    build: (sr) => {
      const f0 = 2400;
      const r = 0.985; // pole radius shaping notch depth/width
      const w0 = (2 * Math.PI * f0) / sr;
      const delay = msToSamples(5, sr);
      // biquad notch numerator: 1 - 2cos(w0) z^-1 + z^-2, mild pole smoothing
      const b = [1, -2 * Math.cos(w0), 1];
      const a = [1, -2 * r * Math.cos(w0), r * r];
      // normalize to 0dB far from notch (use DC gain)
      const dcB = b[0] + b[1] + b[2];
      const dcA = a[0] + a[1] + a[2];
      const g = dcA / dcB;
      const len = delay + 256;
      const h = new Float32Array(len);
      // IIR difference equation driven by a delayed impulse
      const x = new Float64Array(len);
      x[delay] = g;
      const y = new Float64Array(len);
      for (let n = 0; n < len; n++) {
        let acc = b[0] * x[n];
        if (n >= 1) acc += b[1] * x[n - 1] - a[1] * y[n - 1];
        if (n >= 2) acc += b[2] * x[n - 2] - a[2] * y[n - 2];
        y[n] = acc;
        h[n] = acc;
      }
      return h;
    },
  },
];

export function getSystem(id: SystemId): SystemDef {
  const def = SYSTEMS.find((s) => s.id === id);
  if (!def) throw new Error(`unknown system: ${id}`);
  return def;
}
