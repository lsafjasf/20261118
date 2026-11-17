// The canonical sample scene: three 50%-alpha color blocks overlapping on a
// 96x64 canvas. `frame` shifts the blocks so video frames are not identical.
export const WIDTH = 96;
export const HEIGHT = 64;
export const ALPHA_50 = 128;
export const BACKGROUND = [255, 255, 255];

export function makeScene(frame = 0) {
  const dx = frame;
  return {
    width: WIDTH,
    height: HEIGHT,
    background: BACKGROUND,
    layers: [
      { name: 'red', color: [255, 0, 0], alpha: ALPHA_50, x: 8 + dx, y: 8, w: 48, h: 32 },
      { name: 'green', color: [0, 255, 0], alpha: ALPHA_50, x: 40 + dx, y: 8, w: 48, h: 32 },
      { name: 'blue', color: [0, 0, 255], alpha: ALPHA_50, x: 24 + dx, y: 24, w: 48, h: 32 },
    ],
  };
}

// Probe points (frame 0) covering every overlap combination.
export const PROBES = {
  empty: [2, 2],
  red: [10, 10],
  green: [80, 10],
  blue: [30, 50],
  redGreen: [50, 10],
  redBlue: [30, 30],
  greenBlue: [60, 30],
  redGreenBlue: [50, 30],
};
