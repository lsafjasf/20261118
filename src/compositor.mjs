// 8-bit alpha compositor core, shared by the browser UI and the Node verifier.
// All compositing happens in premultiplied space; inputs may be straight or
// premultiplied and are normalized once at the pipeline entry.

export const STRAIGHT = 'straight';
export const PREMULTIPLIED = 'premultiplied';

// Round-to-nearest 8-bit multiply: c * a / 255.
export function mul8(c, a) {
  return Math.round((c * a) / 255);
}

// px: [r, g, b, a] -> premultiplied [r, g, b, a]
export function toPremultiplied(px, mode) {
  if (mode === PREMULTIPLIED) {
    const a = px[3];
    // Defensive clamp: a premultiplied channel may never exceed alpha.
    return [
      Math.min(px[0], a),
      Math.min(px[1], a),
      Math.min(px[2], a),
      a,
    ];
  }
  const a = px[3];
  return [mul8(px[0], a), mul8(px[1], a), mul8(px[2], a), a];
}

// Porter-Duff "over" in premultiplied space. src over dst.
export function over(src, dst) {
  const invA = 255 - src[3];
  return [
    src[0] + mul8(dst[0], invA),
    src[1] + mul8(dst[1], invA),
    src[2] + mul8(dst[2], invA),
    src[3] + mul8(dst[3], invA),
  ];
}

// premultiplied -> straight. Zero alpha maps to zero color (no black fringe:
// color channels of fully transparent pixels are simply undefined).
export function unPremultiply(px) {
  const a = px[3];
  if (a === 0) return [0, 0, 0, 0];
  return [
    Math.min(255, Math.round((px[0] * 255) / a)),
    Math.min(255, Math.round((px[1] * 255) / a)),
    Math.min(255, Math.round((px[2] * 255) / a)),
    a,
  ];
}

// A layer is an axis-aligned rectangle of uniform straight-alpha color.
// layer = { color: [r,g,b], alpha: 0..255, x, y, w, h }
export function layerPixelAt(layer, x, y) {
  if (x < layer.x || x >= layer.x + layer.w || y < layer.y || y >= layer.y + layer.h) {
    return [0, 0, 0, 0];
  }
  return [layer.color[0], layer.color[1], layer.color[2], layer.alpha];
}

// Composite one pixel through every layer (bottom to top) and record each
// intermediate value so the UI can show the four channels at every step.
// mode selects how layer inputs are interpreted; the result is identical
// either way because both representations normalize to the same premul values.
export function compositePixel(layers, x, y, mode) {
  const steps = [];
  let acc = [0, 0, 0, 0]; // premultiplied accumulator
  for (const layer of layers) {
    const straightPx = layerPixelAt(layer, x, y);
    // The source asset stores the same image in one of two representations.
    // A premultiplied source carries mul8(color, alpha); a straight source
    // carries the raw color. Normalizing either one yields identical premul
    // values, so toggling the representation never changes the output.
    const input =
      mode === PREMULTIPLIED ? toPremultiplied(straightPx, STRAIGHT) : straightPx;
    const premul = toPremultiplied(input, mode);
    acc = over(premul, acc);
    steps.push({ layer, input, premul, acc: [...acc] });
  }
  return { steps, finalPremul: acc, finalStraight: unPremultiply(acc) };
}

// Blend a premultiplied pixel over an opaque background color [r,g,b].
export function blendOverBackground(premulPx, bg) {
  return over(premulPx, [bg[0], bg[1], bg[2], 255]).slice(0, 3);
}

// Render the whole scene. Returns straight-alpha RGBA bytes (canvas/PNG/video
// ready) plus the premultiplied buffer used internally.
export function renderFrame(scene, mode) {
  const { width, height, layers } = scene;
  const straight = new Uint8ClampedArray(width * height * 4);
  const premul = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { finalPremul, finalStraight } = compositePixel(layers, x, y, mode);
      const i = (y * width + x) * 4;
      premul[i] = finalPremul[0];
      premul[i + 1] = finalPremul[1];
      premul[i + 2] = finalPremul[2];
      premul[i + 3] = finalPremul[3];
      straight[i] = finalStraight[0];
      straight[i + 1] = finalStraight[1];
      straight[i + 2] = finalStraight[2];
      straight[i + 3] = finalStraight[3];
    }
  }
  return { width, height, straight, premul };
}

// Opaque RGB image of the frame blended over a background color.
export function renderOverBackground(scene, mode, bg) {
  const { width, height } = scene;
  const { premul } = renderFrame(scene, mode);
  const rgb = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const blended = blendOverBackground(
      [premul[i * 4], premul[i * 4 + 1], premul[i * 4 + 2], premul[i * 4 + 3]],
      bg
    );
    rgb[i * 4] = blended[0];
    rgb[i * 4 + 1] = blended[1];
    rgb[i * 4 + 2] = blended[2];
    rgb[i * 4 + 3] = 255;
  }
  return rgb;
}
