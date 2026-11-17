export const INPUT_RATE = 44100;
export const OUTPUT_RATE = 48000;
export const DURATION_SECONDS = 6;
export const INPUT_FRAMES = INPUT_RATE * DURATION_SECONDS;
export const OUTPUT_FRAMES = OUTPUT_RATE * DURATION_SECONDS;

export const INTERPOLATION = 160;
export const DECIMATION = 147;

export const TAP_OPTIONS = [32, 64, 128, 256];
export const DEFAULT_TAPS = 128;
export const REFERENCE_TAPS = 512;
export const KAISER_BETA = 9;

export const TRANSIENT_TIME = 1.8;

export const REGIONS = [
  {
    id: 'head',
    label: 'HEAD',
    description: '0.00–0.10 s',
    start: 0,
    end: 0.1,
  },
  {
    id: 'transient',
    label: 'TRANSIENT',
    description: '1.76–1.84 s',
    start: TRANSIENT_TIME - 0.04,
    end: TRANSIENT_TIME + 0.04,
  },
  {
    id: 'tail',
    label: 'TAIL',
    description: '5.90–6.00 s',
    start: DURATION_SECONDS - 0.1,
    end: DURATION_SECONDS,
  },
];

export const SIGNAL_SEGMENTS = [
  { type: 'sine', start: 0, end: 1.25, label: '997 + 1331 Hz' },
  { type: 'silence', start: 1.25, end: 1.62, label: 'silence' },
  { type: 'transient', start: 1.62, end: 1.9, label: 'transient' },
  { type: 'silence', start: 1.9, end: 2.55, label: 'silence' },
  { type: 'sine', start: 2.55, end: 3.95, label: '7.42 kHz' },
  { type: 'silence', start: 3.95, end: 4.35, label: 'silence' },
  { type: 'sine', start: 4.35, end: 5.35, label: '19.5 kHz' },
  { type: 'sine', start: 5.35, end: 5.7, label: '1 kHz' },
  { type: 'silence', start: 5.7, end: 6, label: 'silence' },
];

export const REFERENCE_FILE = new URL('../assets/reference-48k.f32.wav', import.meta.url);
