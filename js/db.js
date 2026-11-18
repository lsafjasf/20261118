// IndexedDB persistence for recording sessions.
// Schema:
//   meta   -> { id: 'session', state, segment, seq, activeMs, updatedAt }
//   chunks -> auto-incrementing key, { segment, seq, size, createdAt, blob }

const DB_NAME = 'screen-recorder-db';
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', {
          keyPath: 'key',
          autoIncrement: true,
        });
        store.createIndex('bySegment', 'segment', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const result = fn(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class RecorderStore {
  constructor() {
    this.db = null;
  }

  async open() {
    this.db = await openDatabase();
    return this;
  }

  async getSession() {
    return requestToPromise(this.db.transaction('meta').objectStore('meta').get('session'));
  }

  async saveSession(session) {
    const record = { ...session, id: 'session', updatedAt: Date.now() };
    await tx(this.db, 'meta', 'readwrite', (store) => store.put(record));
    return record;
  }

  async appendChunk(chunk) {
    const record = { ...chunk, createdAt: Date.now() };
    let key = null;
    await tx(this.db, 'chunks', 'readwrite', (store) => {
      const request = store.add(record);
      request.onsuccess = () => {
        key = request.result;
      };
    });
    return key;
  }

  async getAllChunks() {
    const chunks = await requestToPromise(
      this.db.transaction('chunks').objectStore('chunks').getAll(),
    );
    chunks.sort((a, b) => a.key - b.key);
    return chunks;
  }

  async countChunks() {
    return requestToPromise(this.db.transaction('chunks').objectStore('chunks').count());
  }

  async clear() {
    await tx(this.db, 'chunks', 'readwrite', (store) => store.clear());
    await tx(this.db, 'meta', 'readwrite', (store) => store.clear());
  }
}
