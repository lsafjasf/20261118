(function () {
  'use strict';

  const player = new Player({
    canvas: document.getElementById('screen'),
    renderFps: 30,
    speedup: 3, // decoder runs 3x faster than the renderer
    capacity: 8,
  });
  window.player = player; // exposed for automated verification

  const el = (id) => document.getElementById(id);

  function refresh() {
    const s = player.stats();
    el('queueLen').textContent = `${s.queueLength} / ${s.capacity}`;
    el('avgWait').textContent = s.avgWaitMs.toFixed(1);
    el('dropped').textContent = s.dropped;
    el('live').textContent = s.liveFrames;
    el('rendered').textContent = s.rendered;
    el('maxGap').textContent = s.maxRenderGapMs.toFixed(0);
    el('createdClosed').textContent = `${s.created} / ${s.closed}`;
    el('underruns').textContent = s.underruns;
  }
  setInterval(refresh, 250);

  el('startBtn').addEventListener('click', () => player.start());
  el('stopBtn').addEventListener('click', () => {
    player.stop();
    refresh();
    el('log').textContent += `已停止，内存中帧对象数 = ${player.stats().liveFrames}\n`;
  });
})();
