import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { SparsePcmStore, BYTES_PER_FRAME, CHUNK_FRAMES } from '../src/sparsePcmStore.js';

const SAMPLE_RATE = 48000;

function frame(l, r) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt16(0, l, true);
  new DataView(b.buffer).setInt16(2, r, true);
  return b;
}

function silence(frames) {
  return new Uint8Array(frames * BYTES_PER_FRAME);
}

// Deterministic stereo tone, 16-bit PCM.
function tone(freq, frames, amplitude = 12000) {
  const out = new Uint8Array(frames * BYTES_PER_FRAME);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const l = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t));
    const r = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t + 0.5));
    view.setInt16(i * 4, l, true);
    view.setInt16(i * 4 + 2, r, true);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Long silence + repeated musical phrase + single-sample impulse.
// Section lengths are multiples of CHUNK_FRAMES (except the tail) so the
// repeated phrase lands on the same chunk-grid phase and dedups exactly.
const LAYOUT = {
  leadSilence: 24 * CHUNK_FRAMES, // 98304 frames, ~2s
  phrase: 6 * CHUNK_FRAMES, // 24576 frames
  gapSilence: 12 * CHUNK_FRAMES,
  preImpulseSilence: 5 * CHUNK_FRAMES,
  postImpulseSilence: 4 * CHUNK_FRAMES - 1,
  tailSilence: 5000, // partial tail chunk
};

function makeSynthetic() {
  const L = LAYOUT;
  const phraseA = tone(440, L.phrase);
  const phraseB = tone(660, L.phrase);
  const impulse = silence(1);
  new DataView(impulse.buffer).setInt16(0, 32767, true); // one loud sample
  const impulseAt = L.leadSilence + L.phrase + L.gapSilence
    + L.phrase + L.phrase + L.preImpulseSilence;
  const pcm = concat(
    silence(L.leadSilence),
    phraseA,
    silence(L.gapSilence),
    phraseA, // repeat 1
    phraseA, // repeat 2
    silence(L.preImpulseSilence),
    impulse, // single-sample impulse inside silence
    silence(L.postImpulseSilence),
    phraseB,
    silence(L.tailSilence),
  );
  return { pcm, phraseA, phraseB, impulseAt };
}

let dbSeq = 0;
function openStore(hooks) {
  return new SparsePcmStore({
    indexedDB,
    dbName: `test-${dbSeq++}`,
    hooks,
  }).open();
}

function sliceFrames(pcm, start, count) {
  return pcm.subarray(start * BYTES_PER_FRAME, (start + count) * BYTES_PER_FRAME);
}

test('full recovery is byte-identical', async () => {
  const store = await openStore();
  const { pcm } = makeSynthetic();
  await store.putRecording('rec', pcm, { sampleRate: SAMPLE_RATE });
  const restored = await store.readAll('rec');
  assert.deepEqual(restored, pcm);
  assert.deepEqual(await store.verifyIntegrity(), []);
  store.close();
});

test('random range reads are byte-identical', async () => {
  const store = await openStore();
  const { pcm, impulseAt } = makeSynthetic();
  const totalFrames = pcm.length / BYTES_PER_FRAME;
  await store.putRecording('rec', pcm);

  // deterministic pseudo-random ranges plus targeted edge cases
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ranges = [
    [0, totalFrames], // everything
    [0, 1], // first frame
    [totalFrames - 1, 1], // last frame
    [CHUNK_FRAMES - 2, 4], // straddling a chunk boundary
    [LAYOUT.leadSilence - 1, 2], // phrase/silence boundary
    [LAYOUT.leadSilence, LAYOUT.phrase], // exactly phrase A
    [impulseAt, 1], // the impulse frame
    [impulseAt - CHUNK_FRAMES, 2 * CHUNK_FRAMES], // around the impulse
    [totalFrames - 5000, 5000], // partial tail chunk
  ];
  for (let i = 0; i < 200; i++) {
    const start = Math.floor(rand() * (totalFrames - 1));
    const count = 1 + Math.floor(rand() * Math.min(20000, totalFrames - start));
    ranges.push([start, count]);
  }
  for (const [start, count] of ranges) {
    const got = await store.read('rec', start, count);
    assert.deepEqual(got, sliceFrames(pcm, start, count), `range [${start}, +${count})`);
  }
  assert.deepEqual(await store.verifyIntegrity(), []);
  store.close();
});

test('silence and repeated phrases are stored sparsely', async () => {
  const store = await openStore();
  const { pcm } = makeSynthetic();
  await store.putRecording('rec', pcm);
  const stats = await store.stats();
  // raw PCM is ~1.1 MB; silence segments and dedup must shrink it a lot
  assert.ok(stats.chunkBytes < pcm.length / 5,
    `chunkBytes ${stats.chunkBytes} vs raw ${pcm.length}`);
  // 6 chunks for phrase A (shared by 3 occurrences), 6 for phrase B,
  // 1 for the impulse chunk: 13 unique chunks, 25 segment references
  assert.equal(stats.chunks, 13);
  assert.equal(stats.totalRefs, 25);
  assert.equal(stats.chunkBytes, 13 * CHUNK_FRAMES * BYTES_PER_FRAME);
  assert.deepEqual(await store.verifyIntegrity(), []);
  store.close();
});

test('cross-chunk overwrite edit does not pollute a sibling recording', async () => {
  const store = await openStore();
  const { pcm } = makeSynthetic();
  await store.putRecording('a', pcm);
  await store.putRecording('b', pcm); // shares every chunk with 'a'
  const before = await store.stats();
  assert.equal(before.chunks, 13);
  assert.equal(before.totalRefs, 50); // every chunk referenced twice

  // edit 'a' across a chunk boundary, inside the first phrase
  const editStart = LAYOUT.leadSilence + CHUNK_FRAMES - 100;
  const editFrames = 5000; // touches three chunks
  const patch = tone(880, editFrames, 8000);
  await store.write('a', editStart, patch);

  const expected = cloneBytesForTest(pcm);
  expected.set(patch, editStart * BYTES_PER_FRAME);

  // 'a' reflects the edit everywhere
  assert.deepEqual(await store.readAll('a'), expected);
  // 'b' is untouched, byte for byte
  assert.deepEqual(await store.readAll('b'), pcm);
  // random probes on 'b' around the edited span
  for (const start of [editStart - 4096, editStart, editStart + editFrames - 1]) {
    assert.deepEqual(
      await store.read('b', start, 300),
      sliceFrames(pcm, start, 300),
    );
  }
  // the three edited chunks were copied, the rest is still shared
  const after = await store.stats();
  assert.equal(after.chunks, before.chunks + 3);
  assert.deepEqual(await store.verifyIntegrity(), []);
  store.close();
});

test('overwrite can turn data into silence and back', async () => {
  const store = await openStore();
  const { pcm } = makeSynthetic();
  await store.putRecording('rec', pcm);

  // erase phrase A's first occurrence into silence
  await store.write('rec', LAYOUT.leadSilence, silence(LAYOUT.phrase));
  const erased = cloneBytesForTest(pcm);
  erased.set(silence(LAYOUT.phrase), LAYOUT.leadSilence * BYTES_PER_FRAME);
  assert.deepEqual(await store.readAll('rec'), erased);
  const mid = await store.stats();
  // phrase A chunks survive: the two later repeats still reference them
  assert.equal(mid.chunks, 13);
  assert.equal(mid.totalRefs, 19); // 2*6 phrase A + 6 phrase B + 1 impulse

  // write a fresh tone back into the silent hole
  const patch = tone(550, LAYOUT.phrase, 9000);
  await store.write('rec', LAYOUT.leadSilence, patch);
  const expected = cloneBytesForTest(erased);
  expected.set(patch, LAYOUT.leadSilence * BYTES_PER_FRAME);
  assert.deepEqual(await store.readAll('rec'), expected);
  assert.deepEqual(await store.verifyIntegrity(), []);
  store.close();
});

function cloneBytesForTest(u8) {
  return new Uint8Array(u8);
}

test('shared chunks are reclaimed only after the last reference', async () => {
  const store = await openStore();
  const { pcm, phraseB } = makeSynthetic();
  await store.putRecording('a', pcm);
  await store.putRecording('b', pcm); // identical: shares all 13 chunks
  await store.putRecording('c', concat(phraseB, silence(100)));
  const full = await store.stats();
  assert.equal(full.chunks, 13); // phrase B chunks also shared with 'c'

  // deleting 'a' must not free anything: 'b' still references every chunk
  await store.deleteRecording('a');
  const afterA = await store.stats();
  assert.equal(afterA.chunks, full.chunks);
  assert.equal(afterA.chunkBytes, full.chunkBytes);
  assert.deepEqual(await store.readAll('b'), pcm); // still fully readable

  // deleting 'b' frees the chunks only it used (phrase A + impulse),
  // phrase B chunks stay alive for 'c'
  await store.deleteRecording('b');
  const afterB = await store.stats();
  assert.equal(afterB.chunks, 6);
  assert.equal(afterB.chunkBytes, 6 * CHUNK_FRAMES * BYTES_PER_FRAME);
  assert.deepEqual(await store.readAll('c'), concat(phraseB, silence(100)));

  // last reference gone: everything is reclaimed
  await store.deleteRecording('c');
  const empty = await store.stats();
  assert.equal(empty.chunks, 0);
  assert.equal(empty.chunkBytes, 0);
  assert.equal(empty.recordings, 0);
  assert.deepEqual(await store.verifyIntegrity(), []);
  store.close();
});

test('interrupted write is atomic: reopening shows no partial state', async () => {
  const dbName = `test-crash-${dbSeq++}`;
  const { pcm } = makeSynthetic();

  const store = await new SparsePcmStore({ indexedDB, dbName }).open();
  await store.putRecording('rec', pcm);
  const stable = await store.stats();

  // simulate a crash: abort the transaction in the middle of a write,
  // after some chunk records have already been put
  let sabotage = true;
  const crashy = await new SparsePcmStore({
    indexedDB,
    dbName,
    hooks: {
      beforeCommit(tx, label) {
        if (sabotage && label === 'write') tx.abort();
      },
    },
  }).open();
  const patch = tone(999, 3000, 5000);
  await assert.rejects(crashy.write('rec', LAYOUT.leadSilence + 10, patch));
  crashy.close();
  store.close();

  // reopen the database and verify nothing leaked or changed
  sabotage = false;
  const reopened = await new SparsePcmStore({ indexedDB, dbName }).open();
  assert.deepEqual(await reopened.readAll('rec'), pcm); // old data intact
  assert.deepEqual(await reopened.stats(), stable); // no space leaked
  assert.deepEqual(await reopened.verifyIntegrity(), []); // no dangling refs

  // and the database is fully usable afterwards
  await reopened.write('rec', LAYOUT.leadSilence + 10, patch);
  const expected = cloneBytesForTest(pcm);
  expected.set(patch, (LAYOUT.leadSilence + 10) * BYTES_PER_FRAME);
  assert.deepEqual(await reopened.readAll('rec'), expected);
  assert.deepEqual(await reopened.verifyIntegrity(), []);
  reopened.close();
});

test('interrupted putRecording leaves no orphaned chunks', async () => {
  const dbName = `test-crash-${dbSeq++}`;
  const { pcm } = makeSynthetic();

  const crashy = await new SparsePcmStore({
    indexedDB,
    dbName,
    hooks: {
      beforeCommit(tx, label) {
        if (label === 'putRecording') tx.abort();
      },
    },
  }).open();
  await assert.rejects(crashy.putRecording('rec', pcm));
  crashy.close();

  const reopened = await new SparsePcmStore({ indexedDB, dbName }).open();
  assert.equal(await reopened.getInfo('rec'), null); // recording never existed
  const stats = await reopened.stats();
  assert.equal(stats.chunks, 0); // no orphaned chunks occupy space
  assert.equal(stats.chunkBytes, 0);
  assert.deepEqual(await reopened.verifyIntegrity(), []);
  reopened.close();
});
