// 用最小 DOM 桩在 Node 中加载 ui.js，验证渲染与按钮事件不抛异常。
// 这不是完整浏览器测试，仅保证模块接线、字段名与渲染函数可执行。

class StubElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._listeners = {};
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.value = '5';
  }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this._listeners[type] || []) fn({}); }
  querySelector() { return new StubElement('span'); }
  classList = {
    add: () => {},
    toggle: () => {},
  };
}

const elements = new Map();
const ids = [
  'timeline', 'btn-play', 'btn-step', 'btn-backward-seek', 'btn-rapid-seek',
  'btn-reset', 'speed', 'seek-time', 'btn-seek', 'event-log', 'memory-bar',
  'stat-current', 'stat-clock', 'stat-memory', 'stat-evicted',
  'stat-evicted-bytes', 'stat-refetch', 'stat-refetch-detail',
  'stat-requests', 'stat-requests-detail', 'stat-avsync', 'stat-avsync-detail',
];
for (const id of ids) elements.set(id, new StubElement());

globalThis.document = {
  getElementById: (id) => elements.get(id) || new StubElement(),
  createElement: (tag) => new StubElement(tag),
};
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = () => 0;
globalThis.location = { reload: () => {} };

await import('../ui.js');

// 触发主要交互路径。
elements.get('btn-seek').dispatch('click');
elements.get('btn-step').dispatch('click');
elements.get('btn-play').dispatch('click');
elements.get('btn-backward-seek').dispatch('click');
elements.get('btn-rapid-seek').dispatch('click');

// 等待场景里的 setTimeout 回调（最长 350*5+900ms 链）。
await new Promise((resolve) => setTimeout(resolve, 3000));

const currentText = elements.get('stat-current').textContent;
const avText = elements.get('stat-avsync').textContent;
if (!currentText || !avText) throw new Error('统计卡片未完成渲染');
console.log(`[PASS] ui.js DOM 桩冒烟测试通过（当前位置: ${currentText}，三轨: ${avText}）`);
