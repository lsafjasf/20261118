import { ScreenRecorder } from './recorder.js';

const $ = (id) => document.getElementById(id);
const recorder = new ScreenRecorder();
window.__recorder = recorder; // used by the automated verification

const STATE_LABELS = {
  idle: '空闲',
  recording: '录制中',
  paused: '已暂停',
  stopped: '已停止',
};

function log(message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const el = $('log');
  el.textContent += `[${time}] ${message}\n`;
  el.scrollTop = el.scrollHeight;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function render(stats) {
  $('stat-state').textContent = STATE_LABELS[stats.state] || stats.state;
  $('stat-duration').textContent = `${(stats.activeMs / 1000).toFixed(1)} s`;
  $('stat-video-blocks').textContent = String(stats.videoBlocks);
  $('stat-audio-blocks').textContent = String(stats.audioBlocks);
  $('stat-chunks').textContent = String(stats.chunks);
  $('stat-segments').textContent = String(stats.segments);
  $('stat-size').textContent = formatBytes(stats.bytes);

  $('btn-start').disabled = stats.state !== 'idle';
  $('btn-pause').disabled = stats.state !== 'recording';
  $('btn-resume').disabled = !(stats.state === 'paused' && recorder.recorder);
  $('btn-stop').disabled =
    stats.state !== 'recording' && !(stats.state === 'paused' && recorder.recorder);
  $('btn-download').disabled = stats.chunks === 0 || stats.state === 'recording';
}

function renderRecovery(info) {
  if (!info) return;
  $('recovery-text').textContent =
    `检测到未完成的录制：已从 IndexedDB 恢复 ${info.chunks} 个分片` +
    `（${info.segments} 段，${formatBytes(info.bytes)}，` +
    `已录 ${(info.activeMs / 1000).toFixed(1)} s）`;
  $('recovery-banner').classList.remove('hidden');
  log(`恢复会话：加载 ${info.chunks} 个分片 / ${info.segments} 段`);
}

async function main() {
  const recovery = await recorder.init();
  if (recovery) renderRecovery(recovery);
  render(recorder.getStats());

  recorder.addEventListener('change', (event) => render(event.detail));
  setInterval(() => {
    if (recorder.state === 'recording') render(recorder.getStats());
  }, 200);

  $('btn-start').onclick = async () => {
    try {
      await recorder.start();
      log('开始录制（屏幕视频 + 麦克风音频）');
    } catch (err) {
      log(`开始失败：${err.message}`);
    }
  };
  $('btn-recover').onclick = async () => {
    $('recovery-banner').classList.add('hidden');
    try {
      await recorder.start();
      log(`恢复后继续录制，进入第 ${recorder.segment + 1} 段`);
    } catch (err) {
      log(`恢复录制失败：${err.message}`);
    }
  };
  $('btn-discard').onclick = async () => {
    $('recovery-banner').classList.add('hidden');
    await recorder.discard();
    log('已丢弃 IndexedDB 中的录制数据');
  };
  $('btn-pause').onclick = () => {
    recorder.pause();
    log('已暂停（已有分片保留在 IndexedDB）');
  };
  $('btn-resume').onclick = () => {
    recorder.resume();
    log('继续录制');
  };
  $('btn-stop').onclick = async () => {
    await recorder.stop();
    log('已停止，正在写入最后一个分片…');
  };
  $('btn-download').onclick = async () => {
    const blob = await recorder.buildFile();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${Date.now()}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    log(`已生成 ${formatBytes(blob.size)} 的 WebM 文件`);
  };
  $('btn-clear').onclick = async () => {
    await recorder.discard();
    log('已清除全部数据');
  };
}

main().catch((err) => log(`初始化失败：${err.message}`));
