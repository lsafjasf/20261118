/// <reference lib="webworker" />
import { createWebCodecsEnvironment } from '../web/webcodecs-env.js';
import { createWorkerHandler } from './handler.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * 浏览器 Web Worker 入口：
 *   new Worker(new URL('./decoder-worker.js', import.meta.url), { type: 'module' })
 */
const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

const handler = createWorkerHandler(createWebCodecsEnvironment(), {
  postMessage(message, transfer) {
    scope.postMessage(message, (transfer ?? []) as Transferable[]);
  },
});

scope.onmessage = (ev) => {
  void handler.dispatch(ev.data);
};
