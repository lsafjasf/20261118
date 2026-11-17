// Bounded-concurrency task pool with AbortSignal support.
// At most `limit` worker tasks are in flight at any instant, which keeps the
// number of decoded VideoFrames held by the pipeline bounded as well.

export class AbortError extends Error {
  constructor(message = 'Task aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortError();
}

export async function runPool(items, limit, worker, signal) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('concurrency limit must be a positive integer');
  }
  throwIfAborted(signal);

  let cursor = 0;
  let abortRejection = null;

  const onAbort = () => {
    if (!abortRejection) abortRejection = new AbortError();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const maxObserved = { value: 0 };
  let active = 0;

  async function workerLoop() {
    while (true) {
      if (abortRejection) throw abortRejection;
      if (cursor >= items.length) return;
      const index = cursor++;
      active++;
      maxObserved.value = Math.max(maxObserved.value, active);
      try {
        await worker(items[index], index);
      } finally {
        active--;
      }
    }
  }

  try {
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
  return { maxConcurrency: maxObserved.value };
}
