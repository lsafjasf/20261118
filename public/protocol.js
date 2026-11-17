// Shared wire protocol between server and browser client.
// Every datagram carries a fixed-size little-endian header followed by payload.
//
// Header layout (29 bytes):
//   u8   kind        1 = video, 2 = audio
//   u32  seq         per-kind frame sequence number
//   u16  chunkIdx    index of this chunk inside the frame
//   u16  chunkCount  total chunks of the frame
//   f64  pts         media timestamp in ms (send-schedule time)
//   f64  sendTs      server Date.now() when the chunk was dispatched
//   u32  flags       bit0 = keyframe (video) (offset 25)

export const KIND_VIDEO = 1;
export const KIND_AUDIO = 2;
export const HEADER_BYTES = 29;
export const MAX_CHUNK_PAYLOAD = 1000;

export function encodeDatagram(kind, seq, chunkIdx, chunkCount, pts, sendTs, payload, flags = 0) {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, seq, true);
  view.setUint16(5, chunkIdx, true);
  view.setUint16(7, chunkCount, true);
  view.setFloat64(9, pts, true);
  view.setFloat64(17, sendTs, true);
  view.setUint32(25, flags, true);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeDatagram(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    kind: view.getUint8(0),
    seq: view.getUint32(1, true),
    chunkIdx: view.getUint16(5, true),
    chunkCount: view.getUint16(7, true),
    pts: view.getFloat64(9, true),
    sendTs: view.getFloat64(17, true),
    flags: view.getUint32(25, true),
    payload: new Uint8Array(data.buffer, data.byteOffset + HEADER_BYTES, data.byteLength - HEADER_BYTES),
  };
}
