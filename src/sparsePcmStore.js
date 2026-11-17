// Sparse PCM storage on top of IndexedDB.
//
// Input format is fixed: stereo (2ch) 16-bit PCM => 4 bytes per frame.
// The recording is split into fixed-size chunks on a global frame grid.
// All-zero chunks are stored as a silence segment (a bare frame count);
// non-silent chunks are content-addressed so byte-identical chunks are
// stored once and shared. Every chunk carries a CRC32 checksum and a
// reference count; a chunk is reclaimed only when its last reference
// disappears. All mutations run in a single IndexedDB transaction
// spanning both object stores, so an interrupted write leaves no
// partial state behind.
import { crc32, fnv1a64, bytesEqual, isAllZero } from './hash.js';

export const BYTES_PER_FRAME = 4; // stereo * 16-bit
export const CHUNK_FRAMES = 4096;
export const CHUNK_BYTES = CHUNK_FRAMES * BYTES_PER_FRAME;

const DB_VERSION = 1;
const STORE_RECORDINGS = 'recordings';
const STORE_CHUNKS = 'chunks';

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
  });
}

function cloneBytes(u8) {
  return u8 instanceof Uint8Array ? new Uint8Array(u8) : new Uint8Array(u8);
}

export class SparsePcmStore {
  constructor({ indexedDB, dbName = 'sparse-pcm', hooks = {} } = {}) {
    if (!indexedDB) throw new Error('an indexedDB factory is required');
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.hooks = hooks; // { beforeCommit(tx, label) } - test hook, may abort
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  _tx(label) {
    const tx = this.db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');
    return {
      tx,
      recordings: tx.objectStore(STORE_RECORDINGS),
      chunks: tx.objectStore(STORE_CHUNKS),
      done: txDone(tx),
      label,
    };
  }

  // Pure: split pcm into grid-aligned segments starting at startFrame.
  // Returns { segments, candidates: Map<provisionalId, {id,data,checksum}> }.
  _segment(pcm, startFrame) {
    const segments = [];
    const candidates = new Map();
    const totalFrames = pcm.length / BYTES_PER_FRAME;
    for (let frame = 0; frame < totalFrames; frame += CHUNK_FRAMES) {
      const end = Math.min(frame + CHUNK_FRAMES, totalFrames);
      const data = pcm.subarray(frame * BYTES_PER_FRAME, end * BYTES_PER_FRAME);
      const start = startFrame + frame;
      if (isAllZero(data)) {
        const last = segments[segments.length - 1];
        if (last && last.type === 'silence') {
          last.frames += end - frame;
        } else {
          segments.push({ start, frames: end - frame, type: 'silence' });
        }
      } else {
        const copy = cloneBytes(data);
        const id = `${fnv1a64(copy)}:${copy.length}`;
        if (!candidates.has(id)) {
          candidates.set(id, { id, data: copy, checksum: crc32(copy) });
        }
        segments.push({ start, frames: end - frame, type: 'data', chunkId: id });
      }
    }
    return { segments, candidates };
  }

  // Intern candidate chunks: reuse an existing identical chunk when possible,
  // create it (refCount 0) otherwise. Hash collisions are resolved by probing
  // `id#n` suffixes and comparing full bytes, so dedup is always exact.
  // Returns Map<provisionalId, finalId>.
  async _internChunks(chunksStore, candidates) {
    const idMap = new Map();
    for (const [provId, cand] of candidates) {
      let finalId = null;
      for (let n = 0; ; n++) {
        const probe = n === 0 ? provId : `${provId}#${n}`;
        const existing = await req(chunksStore.get(probe));
        if (!existing) {
          await req(chunksStore.put({
            id: probe, data: cand.data, checksum: cand.checksum, refCount: 0,
          }));
          finalId = probe;
          break;
        }
        if (bytesEqual(existing.data, cand.data)) {
          finalId = probe;
          break;
        }
      }
      idMap.set(provId, finalId);
    }
    return idMap;
  }

  async _addRefs(chunksStore, chunkId, count) {
    const chunk = await req(chunksStore.get(chunkId));
    if (!chunk) throw new Error(`missing chunk ${chunkId}`);
    chunk.refCount += count;
    await req(chunksStore.put(chunk));
  }

  async _releaseChunk(chunksStore, chunkId) {
    const chunk = await req(chunksStore.get(chunkId));
    if (!chunk) throw new Error(`dangling chunk reference: ${chunkId}`);
    chunk.refCount -= 1;
    if (chunk.refCount <= 0) {
      await req(chunksStore.delete(chunkId));
    } else {
      await req(chunksStore.put(chunk));
    }
  }

  // Replace the segments of `rec` covering [spanStart, spanEnd) with
  // `newSegments`; returns { segments, removedChunkIds }.
  _spliceSegments(rec, spanStart, spanEnd, newSegments) {
    const out = [];
    const removedChunkIds = [];
    for (const seg of rec.segments) {
      const segEnd = seg.start + seg.frames;
      if (segEnd <= spanStart || seg.start >= spanEnd) {
        out.push(seg);
        continue;
      }
      if (seg.type === 'data') {
        // data segments are grid-aligned chunks, and so is the span,
        // hence any overlapping data segment is fully contained
        if (seg.start < spanStart || segEnd > spanEnd) {
          throw new Error('internal: data segment crosses span boundary');
        }
        removedChunkIds.push(seg.chunkId);
      } else {
        if (seg.start < spanStart) {
          out.push({ start: seg.start, frames: spanStart - seg.start, type: 'silence' });
        }
        if (segEnd > spanEnd) {
          out.push({ start: spanEnd, frames: segEnd - spanEnd, type: 'silence' });
        }
      }
    }
    out.push(...newSegments);
    out.sort((a, b) => a.start - b.start);
    // merge adjacent silence segments
    const merged = [];
    for (const seg of out) {
      const last = merged[merged.length - 1];
      if (last && last.type === 'silence' && seg.type === 'silence'
          && last.start + last.frames === seg.start) {
        last.frames += seg.frames;
      } else {
        merged.push({ ...seg });
      }
    }
    return { segments: merged, removedChunkIds };
  }

  // Commit helper: apply a mutation inside one atomic transaction.
  // mutate({recordings, chunks}) may read/write stores and must be sync
  // except for awaiting IDB requests on the same transaction.
  async _atomic(label, mutate) {
    const { tx, recordings, chunks, done } = this._tx(label);
    done.catch(() => {}); // handled via await below / mutation error path
    try {
      const result = await mutate({ recordings, chunks });
      if (this.hooks.beforeCommit) this.hooks.beforeCommit(tx, label);
      await done;
      return result;
    } catch (err) {
      try { tx.abort(); } catch { /* already finished */ }
      throw err;
    }
  }

  async _applySegmentChange(label, id, build) {
    return this._atomic(label, async ({ recordings, chunks }) => {
      const rec = await req(recordings.get(id));
      const plan = await build(rec, chunks);
      const { addedSegments, candidates, removedChunkIds, finalize } = plan;
      const idMap = await this._internChunks(chunks, candidates);
      const refCounts = new Map();
      for (const seg of addedSegments) {
        if (seg.type !== 'data') continue;
        seg.chunkId = idMap.get(seg.chunkId);
        refCounts.set(seg.chunkId, (refCounts.get(seg.chunkId) ?? 0) + 1);
      }
      for (const [chunkId, count] of refCounts) {
        await this._addRefs(chunks, chunkId, count);
      }
      for (const chunkId of removedChunkIds) {
        await this._releaseChunk(chunks, chunkId);
      }
      const record = finalize();
      await req(recordings.put(record));
      return record;
    });
  }

  _validatePcm(pcm) {
    if (!(pcm instanceof Uint8Array)) throw new TypeError('pcm must be a Uint8Array');
    if (pcm.length % BYTES_PER_FRAME !== 0) {
      throw new Error('pcm length must be a multiple of 4 bytes (stereo 16-bit)');
    }
  }

  // Create or fully replace a recording.
  async putRecording(id, pcm, { sampleRate = 48000 } = {}) {
    this._validatePcm(pcm);
    return this._applySegmentChange('putRecording', id, async (rec) => {
      const removedChunkIds = [];
      if (rec) {
        for (const seg of rec.segments) {
          if (seg.type === 'data') removedChunkIds.push(seg.chunkId);
        }
      }
      const { segments, candidates } = this._segment(pcm, 0);
      return {
        addedSegments: segments,
        candidates,
        removedChunkIds,
        finalize: () => ({
          id,
          sampleRate,
          totalFrames: pcm.length / BYTES_PER_FRAME,
          segments,
        }),
      };
    });
  }

  // Overwrite [startFrame, startFrame + pcm.frames) in place.
  async write(id, startFrame, pcm) {
    this._validatePcm(pcm);
    return this._applySegmentChange('write', id, async (rec, chunks) => {
      if (!rec) throw new Error(`recording not found: ${id}`);
      const frames = pcm.length / BYTES_PER_FRAME;
      const endFrame = startFrame + frames;
      if (startFrame < 0 || endFrame > rec.totalFrames) {
        throw new Error(`write range [${startFrame}, ${endFrame}) out of bounds`);
      }
      const spanStart = Math.floor(startFrame / CHUNK_FRAMES) * CHUNK_FRAMES;
      const spanEnd = Math.min(
        Math.ceil(endFrame / CHUNK_FRAMES) * CHUNK_FRAMES,
        rec.totalFrames,
      );
      const oldBytes = await this._assemble(rec, spanStart, spanEnd - spanStart, chunks);
      oldBytes.set(pcm, (startFrame - spanStart) * BYTES_PER_FRAME);
      const { segments, candidates } = this._segment(oldBytes, spanStart);
      const { segments: finalSegments, removedChunkIds } =
        this._spliceSegments(rec, spanStart, spanEnd, segments);
      return {
        addedSegments: segments,
        candidates,
        removedChunkIds,
        finalize: () => ({ ...rec, segments: finalSegments }),
      };
    });
  }

  // Assemble bytes for [startFrame, startFrame+frameCount) from segments.
  async _assemble(rec, startFrame, frameCount, chunksStore) {
    const out = new Uint8Array(frameCount * BYTES_PER_FRAME);
    const endFrame = startFrame + frameCount;
    for (const seg of rec.segments) {
      const segEnd = seg.start + seg.frames;
      const lo = Math.max(seg.start, startFrame);
      const hi = Math.min(segEnd, endFrame);
      if (lo >= hi) continue;
      if (seg.type === 'silence') continue; // output is pre-zeroed
      const chunk = await req(chunksStore.get(seg.chunkId));
      if (!chunk) throw new Error(`dangling chunk reference: ${seg.chunkId}`);
      if (crc32(chunk.data) !== chunk.checksum) {
        throw new Error(`checksum mismatch on chunk ${seg.chunkId}`);
      }
      const srcOff = (lo - seg.start) * BYTES_PER_FRAME;
      const dstOff = (lo - startFrame) * BYTES_PER_FRAME;
      out.set(chunk.data.subarray(srcOff, srcOff + (hi - lo) * BYTES_PER_FRAME), dstOff);
    }
    return out;
  }

  // Random-access read of a frame range, clamped to the recording bounds.
  async read(id, startFrame, frameCount) {
    const tx = this.db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readonly');
    const recordings = tx.objectStore(STORE_RECORDINGS);
    const chunks = tx.objectStore(STORE_CHUNKS);
    const rec = await req(recordings.get(id));
    if (!rec) throw new Error(`recording not found: ${id}`);
    const lo = Math.max(0, Math.min(startFrame, rec.totalFrames));
    const hi = Math.max(lo, Math.min(startFrame + frameCount, rec.totalFrames));
    return this._assemble(rec, lo, hi - lo, chunks);
  }

  async readAll(id) {
    const tx = this.db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readonly');
    const rec = await req(tx.objectStore(STORE_RECORDINGS).get(id));
    if (!rec) throw new Error(`recording not found: ${id}`);
    return this._assemble(rec, 0, rec.totalFrames, tx.objectStore(STORE_CHUNKS));
  }

  async getInfo(id) {
    const tx = this.db.transaction(STORE_RECORDINGS, 'readonly');
    const rec = await req(tx.objectStore(STORE_RECORDINGS).get(id));
    if (!rec) return null;
    return { id: rec.id, sampleRate: rec.sampleRate, totalFrames: rec.totalFrames };
  }

  async deleteRecording(id) {
    return this._atomic('deleteRecording', async ({ recordings, chunks }) => {
      const rec = await req(recordings.get(id));
      if (!rec) return false;
      for (const seg of rec.segments) {
        if (seg.type === 'data') await this._releaseChunk(chunks, seg.chunkId);
      }
      await req(recordings.delete(id));
      return true;
    });
  }

  // Actual storage footprint of the chunk pool.
  async stats() {
    const tx = this.db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readonly');
    const chunks = await req(tx.objectStore(STORE_CHUNKS).getAll());
    const recordings = await req(tx.objectStore(STORE_RECORDINGS).getAll());
    return {
      recordings: recordings.length,
      chunks: chunks.length,
      chunkBytes: chunks.reduce((sum, c) => sum + c.data.byteLength, 0),
      totalRefs: chunks.reduce((sum, c) => sum + c.refCount, 0),
    };
  }

  // Consistency audit; returns a list of problems (empty means healthy).
  async verifyIntegrity() {
    const tx = this.db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readonly');
    const chunks = await req(tx.objectStore(STORE_CHUNKS).getAll());
    const recordings = await req(tx.objectStore(STORE_RECORDINGS).getAll());
    const problems = [];
    const chunkById = new Map(chunks.map((c) => [c.id, c]));
    const actualRefs = new Map();
    for (const rec of recordings) {
      let cursor = 0;
      for (const seg of rec.segments) {
        if (seg.start !== cursor) {
          problems.push(`${rec.id}: segment gap/overlap at frame ${seg.start}`);
        }
        cursor = seg.start + seg.frames;
        if (seg.type === 'data') {
          if (!chunkById.has(seg.chunkId)) {
            problems.push(`${rec.id}: dangling chunk reference ${seg.chunkId}`);
          }
          actualRefs.set(seg.chunkId, (actualRefs.get(seg.chunkId) ?? 0) + 1);
        }
      }
      if (cursor !== rec.totalFrames) {
        problems.push(`${rec.id}: segments cover ${cursor} of ${rec.totalFrames} frames`);
      }
    }
    for (const chunk of chunks) {
      const refs = actualRefs.get(chunk.id) ?? 0;
      if (chunk.refCount !== refs) {
        problems.push(`chunk ${chunk.id}: refCount ${chunk.refCount} != actual ${refs}`);
      }
      if (refs === 0) problems.push(`chunk ${chunk.id}: unreferenced but not reclaimed`);
      if (crc32(chunk.data) !== chunk.checksum) {
        problems.push(`chunk ${chunk.id}: checksum mismatch`);
      }
    }
    return problems;
  }
}
