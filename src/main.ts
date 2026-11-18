import './ui/styles.css';
import { startApp } from './ui/app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('缺少 #app 挂载节点');
}

startApp(root).catch((err) => {
  root.innerHTML = `<pre style="padding:20px;color:#ff6b6b">启动失败：${
    (err as Error).message
  }</pre>`;
});
