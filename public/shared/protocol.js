// Wire protocol for media datagrams.
// All multi-byte integers are big-endian.
//
// Datagram layout:
//   byte 0      : type tag
//   bytes 1..   : type-specific payload
//
// Frame (type 0x01):
//   uint32 seq      increasing frame sequence number, starting at 0
//   float64 sendTsp timestamp (performance.timeOrigin + performance.now(), ms)
//   uint32 size     media payload length
//   bytes  payload  synthetic media payload
//
// Control (type 0x02):
//   float64 clientTsp
//   float64 serverTsp

export const TAG_FRAME = 0x01
export const TAG_CONTROL = 0x02

const HEADER_SIZE = 1 + 4 + 8 + 4

export function encodeFrame(seq, sendTimestamp, payload) {
  const buffer = new ArrayBuffer(HEADER_SIZE + payload.byteLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint8(0, TAG_FRAME)
  view.setUint32(1, seq)
  view.setFloat64(5, sendTimestamp)
  view.setUint32(13, payload.byteLength)
  bytes.set(payload, HEADER_SIZE)
  return bytes
}

export function decodeFrame(bytes) {
  if (bytes.byteLength < HEADER_SIZE || bytes[0] !== TAG_FRAME) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const seq = view.getUint32(1)
  const sendTimestamp = view.getFloat64(5)
  const size = view.getUint32(13)
  if (bytes.byteLength !== HEADER_SIZE + size) return null
  return {
    seq,
    sendTimestamp,
    payload: bytes.subarray(HEADER_SIZE, HEADER_SIZE + size)
  }
}

const CONTROL_SIZE = 1 + 8 + 8

export function encodeControl(clientTimestamp, serverTimestamp) {
  const buffer = new ArrayBuffer(CONTROL_SIZE)
  const view = new DataView(buffer)
  view.setUint8(0, TAG_CONTROL)
  view.setFloat64(1, clientTimestamp)
  view.setFloat64(9, serverTimestamp)
  return new Uint8Array(buffer)
}

export function decodeControl(bytes) {
  if (bytes.byteLength !== CONTROL_SIZE || bytes[0] !== TAG_CONTROL) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    clientTimestamp: view.getFloat64(1),
    serverTimestamp: view.getFloat64(9)
  }
}
