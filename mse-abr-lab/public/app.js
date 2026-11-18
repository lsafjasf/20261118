(async function main() {
  const video = document.getElementById('video');
  const manifest = await fetch('media/manifest.json').then((res) => res.json());

  const network = NetworkSimulator.createNetworkSimulator({ seed: 42 });
  const presetProfile = new URLSearchParams(location.search).get('profile');
  if (presetProfile) network.setProfile(presetProfile);
  const abr = AbrController.createAbrController(manifest.renditions);

  const eventLog = [];
  const els = {
    bitrate: document.getElementById('m-bitrate'),
    rendition: document.getElementById('m-rendition'),
    buffer: document.getElementById('m-buffer'),
    reason: document.getElementById('m-reason'),
    reasonSub: document.getElementById('m-reason-sub'),
    stalls: document.getElementById('m-stalls'),
    lockState: document.getElementById('m-lock-state'),
    throughput: document.getElementById('m-throughput'),
    logBody: document.getElementById('log-body'),
    lockButtons: document.getElementById('lock-buttons'),
  };

  function logger(event) {
    if (event.type === 'segment-appended') {
      eventLog.push(event);
      const row = document.createElement('tr');
      const throughputKbps = Math.round(event.decision.throughputBps / 1000);
      row.innerHTML = `<td>${eventLog.length}</td><td>${event.segmentIndex}</td>`
        + `<td>${(event.bitrate / 1000)}k</td><td>${event.reason}</td>`
        + `<td>${event.decision.bufferSeconds}</td><td>${throughputKbps}</td>`;
      els.logBody.prepend(row);
    } else {
      eventLog.push(event);
    }
  }

  const player = MseAbrPlayer.createPlayer({ video, manifest, abr, network, logger });
  window.__lab = { manifest, network, abr, player, video, eventLog };

  manifest.renditions.forEach((rendition, index) => {
    const button = document.createElement('button');
    button.textContent = `锁定 ${rendition.label}`;
    button.className = 'secondary';
    button.dataset.index = String(index);
    button.addEventListener('click', () => {
      abr.lock(index);
      document.querySelectorAll('#lock-buttons button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
    });
    els.lockButtons.appendChild(button);
  });

  document.getElementById('unlock').addEventListener('click', () => {
    abr.unlock();
    document.querySelectorAll('#lock-buttons button').forEach((item) => item.classList.remove('active'));
  });

  document.querySelectorAll('[data-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      network.setProfile(button.dataset.profile);
      document.querySelectorAll('[data-profile]').forEach((item) => {
        item.classList.toggle('active', item === button);
        item.classList.toggle('secondary', item !== button);
      });
    });
  });

  document.getElementById('burst').addEventListener('click', () => {
    network.injectBurst(200_000, 5000, 0.2);
  });

  function render() {
    const stats = player.getStats();
    const abrState = abr.getState();
    const last = abrState.lastDecision;
    const current = manifest.renditions[abrState.currentIndex];

    els.bitrate.textContent = current ? `${current.bitrate / 1000} kbps` : '-';
    els.rendition.textContent = current ? `${current.id} · 分片 #${stats.nextSegment}` : '-';
    els.buffer.textContent = `${stats.bufferAhead.toFixed(2)} s`;
    els.stalls.textContent = String(stats.stallCount);
    els.reason.textContent = last ? last.reason : '-';
    els.reasonSub.textContent = last
      ? `分片 #${last.segmentIndex} · 当时缓冲 ${last.bufferSeconds}s`
      : '尚无决策';
    els.lockState.textContent = abrState.lockedIndex === null
      ? '自动策略运行中'
      : `已锁定 ${manifest.renditions[abrState.lockedIndex].label}`;
    els.throughput.textContent = abrState.throughputBps === null
      ? '-'
      : `${Math.round(abrState.throughputBps / 1000)} kbps（EWMA）`;
    requestAnimationFrame(render);
  }
  render();

  await player.play();
})().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f87171">${error.stack}</pre>`);
});
