import "./styles.css";
import { FrameInspectorApp, type PublicInspectorState } from "./inspector";

interface InspectorBridge {
  getState(): PublicInspectorState;
  seekToMs(timeMs: number): Promise<void>;
  stepBy(delta: -1 | 1): Promise<void>;
  mark(kind: "in" | "out"): void;
  buildManifest(): void;
}

declare global {
  interface Window {
    __frameInspector?: InspectorBridge;
  }
}

const app = new FrameInspectorApp();
window.__frameInspector = {
  getState: () => app.getState(),
  seekToMs: (timeMs) => app.seekToMs(timeMs),
  stepBy: (delta) => app.stepBy(delta),
  mark: (kind) => app.mark(kind),
  buildManifest: () => app.buildManifest(),
};
