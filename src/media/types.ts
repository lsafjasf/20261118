export type ContainerKind = "mp4" | "webm";

export interface DemuxSample {
  decodeIndex: number;
  timestampUs: number;
  durationUs: number;
  isKey: boolean;
  visible: boolean;
  data: Uint8Array;
  dtsUs?: number;
  rawTimestamp?: number;
}

export interface DemuxedVideo {
  container: ContainerKind;
  codec: string;
  codecLabel: string;
  description?: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  rotation: number;
  timescale: number;
  durationUs: number;
  samples: DemuxSample[];
}

export interface FrameSample extends DemuxSample {
  presentationIndex: number;
  timestampSeconds: number;
}

export interface VideoSource extends Omit<DemuxedVideo, "samples"> {
  samples: DemuxSample[];
  frames: FrameSample[];
  isVfr: boolean;
  minFrameDurationUs: number;
  maxFrameDurationUs: number;
  averageFps: number;
  displayWidth: number;
  displayHeight: number;
}

export type FailureKind =
  | "capability"
  | "container"
  | "demux"
  | "decode"
  | "no-keyframe";

export class InspectionError extends Error {
  readonly kind: FailureKind;
  readonly missing: string[];

  constructor(kind: FailureKind, message: string, missing: string[] = []) {
    super(message);
    this.name = "InspectionError";
    this.kind = kind;
    this.missing = missing;
  }
}
