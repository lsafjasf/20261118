export class Signaling extends EventTarget {
  constructor(role, room = "default") {
    super();
    this.role = role;
    this.room = room;
    this.socket = null;
    this.retryTimer = null;
    this.closed = false;
  }

  connect() {
    if (this.closed) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/signal`);

    this.socket.addEventListener("open", () => {
      this.#emit("status", { state: "open" });
      this.send({ type: "join", role: this.role, room: this.room });
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#emit("message", message);
    });

    this.socket.addEventListener("close", () => {
      this.#emit("status", { state: "closed" });
      if (!this.closed) {
        this.retryTimer = setTimeout(() => this.connect(), 1200);
      }
    });

    this.socket.addEventListener("error", () => {
      this.#emit("status", { state: "error" });
    });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ ...message, room: this.room, from: this.role }));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.send({ type: "leave" });
    this.socket?.close();
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

export function formatClock(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":") + `.${pad(date.getMilliseconds(), 3)}`;
}

export function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

export function quantile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}
