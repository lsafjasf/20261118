// Minimal 16-bit PCM WAV encoder for exporting rendered buffers.
(function (global) {
  'use strict';

  function encodeWav(buffer) {
    var numCh = buffer.numberOfChannels;
    var sr = buffer.sampleRate;
    var n = buffer.length;
    var dataBytes = n * numCh * 2;
    var out = new ArrayBuffer(44 + dataBytes);
    var v = new DataView(out);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * numCh * 2, true); v.setUint16(32, numCh * 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, dataBytes, true);
    var off = 44;
    for (var i = 0; i < n; i++) {
      for (var ch = 0; ch < numCh; ch++) {
        var s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  global.WavEncoder = { encodeWav: encodeWav };
})(typeof self !== 'undefined' ? self : this);
