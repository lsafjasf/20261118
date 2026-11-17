import { demuxMp4 } from "./mp4-demuxer";
import { demuxWebm } from "./webm-demuxer";
import { InspectionError, type VideoSource } from "./types";

export async function demuxFile(file: File): Promise<VideoSource> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isWebm =
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3;
  const isMp4 =
    header.length >= 8 &&
    String.fromCharCode(...header.slice(4, 8)) === "ftyp";

  if (isWebm) return demuxWebm(file);
  if (isMp4) return demuxMp4(file);

  throw new InspectionError(
    "container",
    "无法识别文件容器；仅支持 MP4/MOV（ftyp）和 WebM（EBML）。",
    ["MP4（ISO BMFF）或 WebM（Matroska）容器"],
  );
}
