/** 解码配置描述（与 VideoDecoderConfig 对齐，可结构化克隆）。 */
export interface DecoderConfigDesc {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  optimizeForLatency?: boolean;
}

/** 输入编码块（与 EncodedVideoChunkInit 对齐）。 */
export interface EncodedChunkInput {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}

/** 一段携带解码配置的编码块序列。 */
export interface Segment {
  id: string;
  config: DecoderConfigDesc;
  chunks: EncodedChunkInput[];
}

/** 每个输出帧附带的标记：配置代次、尺寸、所属分段。 */
export interface FrameMeta {
  /** 配置代次：每次成功应用新配置 +1。 */
  generation: number;
  segmentId: string;
  segmentIndex: number;
  width: number;
  height: number;
  timestamp: number;
}

export type SegmentErrorKind =
  | 'unsupported-config'
  | 'configure-failed'
  | 'decode-error'
  | 'missing-keyframe';

export interface SegmentError {
  kind: SegmentErrorKind;
  segmentId: string;
  segmentIndex: number;
  message: string;
  /** unsupported-config 时说明缺失能力。 */
  capability?: string;
  cause?: unknown;
}

/** 单个分段的处理结果统计。 */
export interface SegmentReport {
  segmentId: string;
  segmentIndex: number;
  generation: number;
  decodedFrames: number;
  /** 因等待关键帧而丢弃的前导非关键帧数。 */
  droppedChunks: number;
  error?: SegmentError;
}
