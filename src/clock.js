// 确定性虚拟时钟：所有“网络请求 / 播放推进”都挂在这个时钟上，
// 同一份场景脚本在 Node 与浏览器中跑出完全一致的结果。

export class VirtualClock {
  constructor() {
    this._time = 0;
    this._seq = 0;
    this._timers = []; // { at, id, fn }
  }

  now() {
    return this._time;
  }

  setTimeout(fn, delaySeconds) {
    const id = ++this._seq;
    this._timers.push({ at: this._time + Math.max(0, delaySeconds), id, fn });
    this._timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return id;
  }

  clearTimeout(id) {
    this._timers = this._timers.filter((t) => t.id !== id);
  }

  get pending() {
    return this._timers.length;
  }

  // 推进 deltaSeconds，按时间顺序触发到期回调；回调中新注册的
  // 定时器若落在同一时刻也会被执行。
  advance(deltaSeconds) {
    const deadline = this._time + deltaSeconds;
    while (this._timers.length > 0 && this._timers[0].at <= deadline + 1e-9) {
      const timer = this._timers.shift();
      this._time = timer.at;
      timer.fn();
    }
    this._time = deadline;
  }

  // 直接跳时刻（用于断言点），不触发任何定时器。
  jumpTo(timeSeconds) {
    this._time = timeSeconds;
  }
}
