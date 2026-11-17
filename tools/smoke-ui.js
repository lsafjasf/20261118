/* tools/smoke-ui.js — 用最小 DOM mock 在 Node 中冒烟测试 app.js 的核心流程
 * （无浏览器环境下验证渲染与按钮逻辑不抛异常） */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeEl(id) {
  const el = {
    id,
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    innerHTML: '',
    textContent: '',
    disabled: false,
    draggable: false,
    href: '',
    src: '',
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelector() { return elRegistry['cluster-tbody']; },
    click() {},
  };
  return el;
}

const elRegistry = {};
for (const id of [
  'file-input', 'drop-zone', 'chunk-list', 'stats', 'cluster-table',
  'issue-list', 'structure-tree', 'btn-merge', 'btn-repair', 'btn-export',
  'download-link', 'player', 'repair-summary',
]) {
  elRegistry[id] = makeEl(id);
}
elRegistry['cluster-tbody'] = makeEl('cluster-tbody');

const listenersByElement = elRegistry;

const sandbox = {
  console,
  URL: {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {},
  },
  Blob: class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } },
  setTimeout: (fn) => fn(),
  document: {
    getElementById: (id) => elRegistry[id],
    createElement: (tag) => makeEl(tag),
    querySelector: () => elRegistry['cluster-tbody'],
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['webm-ebml.js', 'webm-repair.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

// 模拟加载 reversed 样本集
const dir = path.join(ROOT, 'samples', 'reversed');
const files = fs.readdirSync(dir).sort().map((f) => ({
  name: f,
  arrayBuffer: async () => {
    const b = fs.readFileSync(path.join(dir, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  },
}));

(async () => {
  // 触发 change 事件加载文件
  const change = listenersByElement['file-input'].listeners.change[0];
  await change({ target: { files } });

  const issuesHtml = elRegistry['issue-list'].children
    .map((c) => c.innerHTML).join('\n');
  if (!issuesHtml.includes('missing-ebml-header')) throw new Error('UI 未显示 missing-ebml-header');
  if (!issuesHtml.includes('cluster-out-of-order')) throw new Error('UI 未显示 cluster-out-of-order');

  // 点击「自动修复并拼接」
  listenersByElement['btn-repair'].listeners.click[0]();
  const summary = elRegistry['repair-summary'].innerHTML;
  if (!summary.includes('1225')) throw new Error('修复摘要缺少字节数: ' + summary);
  if (!elRegistry['player'].src) throw new Error('video 元素未获得 src');
  if (!elRegistry['download-link'].href) throw new Error('下载链接未设置');

  // 点击「导出诊断报告」（不应抛异常）
  listenersByElement['btn-export'].listeners.click[0]();

  // 模拟拖拽换序：把分片 #4 拖到 #0
  const list = elRegistry['chunk-list'];
  const drop = list.children[0].listeners.drop[0];
  drop({
    preventDefault() {},
    dataTransfer: { getData: () => '4' },
  });
  if (!elRegistry['issue-list'].children.length) throw new Error('拖拽后诊断未刷新');

  console.log('UI 冒烟测试通过：诊断渲染、修复、导出、拖拽换序均正常');
  console.log('修复摘要:', summary.replace(/<[^>]+>/g, ''));
})().catch((err) => {
  console.error('UI 冒烟测试失败:', err);
  process.exit(1);
});
