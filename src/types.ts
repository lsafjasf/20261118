export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface KeyerParams {
  /** 采样得到的背景（绿幕）颜色 */
  keyColor: RGB;
  /** 色度距离容差：距离 <= tolerance 的像素完全透明 */
  tolerance: number;
  /** 软边宽度（色度距离单位）：过渡带 [tolerance, tolerance+softness] */
  softness: number;
  /** 去溢色强度 0..1 */
  despill: number;
  /** 歧义像素（被前景包围的近背景色）保留的 alpha 下限 0..255 */
  ambiguityFloor: number;
}

export interface Frame {
  width: number;
  height: number;
  /** 绿幕合成帧 RGBA */
  image: Uint8ClampedArray;
  /** 参考透明度遮罩 0..255 */
  truthAlpha: Uint8ClampedArray;
  /** 未合成的前景真值 RGBA（直色，alpha 同 truthAlpha） */
  truthForeground: Uint8ClampedArray;
  /** 真值中“前景自身颜色接近背景色”的歧义区域 */
  ambiguousTruth: Uint8Array;
}

export interface KeyerResult {
  /** 估计的软遮罩 0..255 */
  alpha: Uint8ClampedArray;
  /** 去溢色后的前景 RGB（RGBA，alpha 为估计值） */
  despilled: Uint8ClampedArray;
  /** 运行时检测到的歧义区域（被前景包围的近背景色像素） */
  ambiguity: Uint8Array;
  /** 每个像素到背景色的色度距离（调试/指标用） */
  distance: Float32Array;
}
