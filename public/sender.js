import { Signaling, formatClock } from "./signal.js";

const $ = (selector) => document.querySelector(selector);
const room = new URLSearchParams(location.search).get("room") || "default";
const canvas = $("#previewCanvas");
const ctx = canvas.getContext("2d");
const captureCanvas = document.createElement("canvas");
captureCanvas.width = 640;
captureCanvas.height = 360;
const captureCtx = captureCanvas.getContext("2d");
const signal = new Signaling("sender", room);

const state = {
  stream: null,
  pc: null,
  videoSender: null,
  audioSender: null,
  audioContext: null,
  profileKbps: 2000,
  started: false,
  transmitting: false,
  receiverPresent: false,
  offered: false,
  frame: 0,
  startedAt: performance.now(),
  pendingOffer: false,
  lastBytes: 0,
  lastStatsAt: 0,
};

function drawSource() {
  const now = new Date();
  const elapsed = (performance.now() - state.startedAt) / 1000;
  state.frame += 1;
  const phase = elapsed * Math.PI * 0.7;
  const x = canvas.width * (0.32 + Math.sin(phase) * 0.13);
  const y = canvas.height * (0.53 + Math.cos(phase * 0.82) * 0.12);
  const glow = 0.65 + Math.sin(elapsed * 2.4) * 0.2;

  ctx.fillStyle = "#061019";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(52, 106, 126, 0.19)";
  ctx.lineWidth = 1;
  for (let gx = 0; gx < canvas.width; gx += 48) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, canvas.height);
    ctx.stroke();
  }
  for (let gy = 0; gy < canvas.height; gy += 48) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(canvas.width, gy);
    ctx.stroke();
  }

  const vignette = ctx.createRadialGradient(
    canvas.width * 0.56,
    canvas.height * 0.48,
    40,
    canvas.width * 0.56,
    canvas.height * 0.48,
    canvas.width * 0.58,
  );
  vignette.addColorStop(0, "rgba(20, 69, 78, 0.13)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = "600 22px monospace";
  ctx.letterSpacing = "4px";
  ctx.fillStyle = "#6a8798";
  ctx.fillText("SYNTHETIC A/V SOURCE · LOCAL LOOPBACK", 54, 54);

  ctx.textAlign = "right";
  ctx.fillStyle = "#c7d6de";
  ctx.fillText(`FRAME ${String(state.frame).padStart(8, "0")}`, canvas.width - 54, 54);
  ctx.font = "500 16px monospace";
  ctx.fillStyle = "#6a8798";
  ctx.fillText(`SEND CAP ${state.profileKbps} kbps`, canvas.width - 54, 82);
  ctx.fillText("AUDIO BEACON · 1 HZ", canvas.width - 54, 106);
  ctx.textAlign = "left";

  ctx.font = "700 86px monospace";
  ctx.fillStyle = "#f5fbff";
  ctx.shadowColor = "rgba(99, 223, 245, 0.32)";
  ctx.shadowBlur = 20;
  ctx.fillText(`00:${formatClock(now).slice(3)}`, 54, 168);
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(elapsed * 0.9) * 0.08);
  ctx.shadowColor = "#56e2f4";
  ctx.shadowBlur = 34 * glow;
  ctx.fillStyle = `rgba(82, 230, 245, ${0.64 + glow * 0.25})`;
  ctx.fillRect(-54, -54, 108, 108);
  ctx.restore();

  const circleX = canvas.width * (0.76 + Math.sin(elapsed * 0.52) * 0.045);
  const circleY = canvas.height * (0.52 + Math.cos(elapsed * 0.63) * 0.14);
  ctx.beginPath();
  ctx.arc(circleX, circleY, 62, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 180, 93, 0.83)";
  ctx.shadowColor = "#ffb45d";
  ctx.shadowBlur = 30;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#638091";
  ctx.font = "500 15px monospace";
  ctx.fillText("640 × 360  ·  30 FPS TARGET", 54, canvas.height - 46);
  ctx.textAlign = "right";
  ctx.fillText("BROWSER-GENERATED CAPTURE", canvas.width - 54, canvas.height - 46);
  ctx.textAlign = "left";
  ctx.fillStyle = "#547183";
  const progress = (elapsed % 1) * (canvas.width - 108);
  ctx.fillRect(54, canvas.height - 26, 54 + progress, 2);
  captureCtx.drawImage(canvas, 0, 0, captureCanvas.width, captureCanvas.height);

  requestAnimationFrame(drawSource);
}

function createAudioTrack() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }
  const audio = state.audioContext;
  const destination = audio.createMediaStreamDestination();
  const master = audio.createGain();
  master.gain.value = 0.035;
  master.connect(destination);

  const tone = audio.createOscillator();
  tone.type = "sine";
  tone.frequency.value = 220;
  const toneGain = audio.createGain();
  toneGain.gain.value = 0.35;
  tone.connect(toneGain).connect(master);
  tone.start();

  let beep = 0;
  const playBeep = () => {
    if (audio.state === "suspended") audio.resume();
    const now = audio.currentTime;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(beep % 2 ? 660 : 880, now);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.42, now + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    oscillator.connect(envelope).connect(master);
    oscillator.start(now);
    oscillator.stop(now + 0.16);
    beep += 1;
  };
  playBeep();
  setInterval(playBeep, 1000);

  const analyser = audio.createAnalyser();
  analyser.fftSize = 256;
  master.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const meter = $("#audioMeter");
  const meterValue = $("#audioMeterValue");
  setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -80;
    meter.style.width = `${Math.min(100, Math.max(2, ((db + 60) / 60) * 100))}%`;
    meterValue.textContent = `${db.toFixed(0)} dB`;
  }, 120);

  return destination.stream.getAudioTracks()[0];
}

async function createLocalStream() {
  if (state.stream) return state.stream;
  const video = captureCanvas.captureStream(30).getVideoTracks()[0];
  video.contentHint = "motion";
  const audio = createAudioTrack();
  if (audio) {
    audio.contentHint = "speech";
    await state.audioContext.resume();
  }
  state.stream = new MediaStream([video, audio].filter(Boolean));
  return state.stream;
}

function setPill(element, text, mode = "") {
  element.textContent = text;
  element.classList.toggle("live", mode === "live");
  element.classList.toggle("alert", mode === "alert");
}

function updateSignalStatus(connected) {
  setPill($("#signalPill"), connected ? "信令已连接" : "信令重连中", connected ? "live" : "alert");
}

function updateConnectionUi() {
  const connection = state.pc?.connectionState || "new";
  if (connection === "connected") {
    setPill($("#senderPill"), "媒体已连接", "live");
    $("#connectionStatus").textContent = state.receiverPresent
      ? "P2P 已连接，接收端正在采样"
      : "P2P 已连接，接收端暂时离线";
  } else if (!state.started) {
    setPill($("#senderPill"), "发送端待机");
    $("#connectionStatus").textContent = "等待启动";
  } else {
    setPill($("#senderPill"), "正在连接", "alert");
    $("#connectionStatus").textContent = `PeerConnection: ${connection}`;
  }
}

function createPeerConnection() {
  if (state.pc) state.pc.close();
  const pc = new RTCPeerConnection({ iceServers: [] });
  state.pc = pc;
  state.offered = false;

  for (const track of state.stream.getTracks()) {
    const sender = pc.addTrack(track, state.stream);
    if (track.kind === "video") state.videoSender = sender;
    if (track.kind === "audio") state.audioSender = sender;
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) signal.send({ type: "candidate", candidate });
  };
  pc.onconnectionstatechange = () => {
    updateConnectionUi();
    if (pc.connectionState === "connected") {
      applyProfile(state.profileKbps).catch((error) => {
        $("#capStatus").textContent = `编码参数未应用：${error.message}`;
      });
    }
    if (pc.connectionState === "failed") {
      $("#connectionStatus").textContent = "连接失败，请刷新两端后重试";
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "disconnected") {
      updateConnectionUi();
    }
  };
  return pc;
}

async function makeOffer() {
  if (!state.started || !state.pc || state.pc.signalingState === "closed") return;
  if (!state.receiverPresent) {
    state.pendingOffer = true;
    $("#connectionStatus").textContent = "发送已就绪，等待接收端加入";
    return;
  }
  if (state.offered && state.pc.connectionState !== "new") return;

  try {
    state.pendingOffer = false;
    state.offered = true;
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    signal.send({ type: "offer", sdp: state.pc.localDescription });
    $("#connectionStatus").textContent = "Offer 已发送，等待接收端";
  } catch (error) {
    state.offered = false;
    $("#connectionStatus").textContent = `创建 Offer 失败：${error.message}`;
  }
}

async function startTransmission() {
  if (state.started) return;
  $("#startBtn").disabled = true;
  $("#startBtn").textContent = "正在准备媒体…";
  try {
    await createLocalStream();
    createPeerConnection();
    state.started = true;
    state.transmitting = true;
    $("#startBtn").textContent = "传输已启动";
    $("#capBtn").disabled = false;
    $("#restoreBtn").disabled = true;
    $("#capStatus").textContent = "当前为正常带宽，点击左侧按钮注入限速";
    $("#sendResolution").textContent = "640×360";
    updateConnectionUi();
    await makeOffer();
  } catch (error) {
    $("#startBtn").disabled = false;
    $("#startBtn").textContent = "重试启动";
    $("#connectionStatus").textContent = `媒体创建失败：${error.message}`;
  }
}

async function applyProfile(kbps) {
  if (!state.videoSender) throw new Error("视频发送器尚未建立");
  const bitrate = Number(kbps) * 1000;
  const params = state.videoSender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  for (const encoding of params.encodings) encoding.maxBitrate = bitrate;

  try {
    params.degradationPreference = "maintain-resolution";
    await state.videoSender.setParameters(params);
  } catch {
    const fallback = state.videoSender.getParameters();
    if (!fallback.encodings?.length) fallback.encodings = [{}];
    for (const encoding of fallback.encodings) encoding.maxBitrate = bitrate;
    await state.videoSender.setParameters(fallback);
  }

  state.profileKbps = Number(kbps);
  $("#profileValue").textContent = `${kbps} kbps`;
  $("#capBtn").disabled = Number(kbps) <= 32;
  $("#restoreBtn").disabled = Number(kbps) > 32;
  $("#capStatus").textContent =
    Number(kbps) <= 32
      ? "限速已生效：保持分辨率，允许帧率下降"
      : "正常带宽已恢复：编码器将重新提升帧率";
  signal.send({ type: "profileChanged", kbps: Number(kbps) });
}

async function handleSignalMessage(message) {
  if (message.type === "presence") {
    const nextPresent = Array.isArray(message.roles) && message.roles.includes("receiver");
    const joined = nextPresent && !state.receiverPresent;
    state.receiverPresent = nextPresent;
    if (state.started) updateConnectionUi();
    if (joined && state.started) {
      createPeerConnection();
      await makeOffer();
    }
    return;
  }

  if (message.type === "answer" && state.pc) {
    await state.pc.setRemoteDescription(message.sdp);
    $("#connectionStatus").textContent = "Answer 已收到，正在建立 P2P";
    return;
  }

  if (message.type === "candidate" && state.pc && message.candidate) {
    try {
      await state.pc.addIceCandidate(message.candidate);
    } catch {
      // Trickle ICE can race a freshly recreated connection.
    }
  }
}

function renderSenderStats(video) {
  const now = performance.now();
  const elapsed = state.lastStatsAt ? (now - state.lastStatsAt) / 1000 : 1;
  const bytes = Number(video?.bytesSent || 0);
  const bitrate = state.lastStatsAt
    ? Math.max(0, ((bytes - state.lastBytes) * 8) / elapsed / 1000)
    : 0;
  const fps = Number(video?.framesPerSecond) || 0;

  $("#sendBitrate").textContent = state.lastStatsAt ? `${bitrate.toFixed(0)} kbps` : "—";
  $("#sendFps").textContent = state.lastStatsAt ? `${fps.toFixed(1)} fps` : "—";
  const reasons = {
    bandwidth: "带宽受限",
    cpu: "CPU 受限",
    other: "其他",
    none: "无",
  };
  $("#qualityReason").textContent = reasons[video?.qualityLimitationReason] || "—";
  $("#packetsSent").textContent = Number(video?.packetsSent || 0).toLocaleString("en-US");
  $("#framesEncoded").textContent = Number(video?.framesEncoded || 0).toLocaleString("en-US");
  $("#sendResolution").textContent = `${video?.frameWidth || 640}×${video?.frameHeight || 360}`;

  state.lastStatsAt = now;
  state.lastBytes = bytes;
}

async function sampleSenderStats() {
  if (!state.pc || state.pc.connectionState === "closed") return;
  try {
    const report = await state.pc.getStats();
    report.forEach((item) => {
      if (item.type === "outbound-rtp" && item.kind === "video") renderSenderStats(item);
    });
  } catch {
    // A closing peer connection can reject getStats during teardown.
  }
}

async function injectCap() {
  if (!state.started) return;
  $("#capBtn").disabled = true;
  $("#capStatus").textContent = "正在把发送上限压到 32 kbps…";
  try {
    await applyProfile(32);
  } catch (error) {
    $("#capBtn").disabled = false;
    $("#capStatus").textContent = `限速失败：${error.message}`;
  }
}

async function restoreBandwidth() {
  if (!state.started) return;
  $("#restoreBtn").disabled = true;
  $("#capStatus").textContent = "正在恢复 2000 kbps…";
  try {
    await applyProfile(2000);
  } catch (error) {
    $("#restoreBtn").disabled = false;
    $("#capStatus").textContent = `恢复失败：${error.message}`;
  }
}

$("#startBtn").addEventListener("click", startTransmission);
$("#capBtn").addEventListener("click", injectCap);
$("#restoreBtn").addEventListener("click", restoreBandwidth);

signal.addEventListener("status", (event) => {
  updateSignalStatus(event.detail.state === "open");
});
signal.addEventListener("message", (event) => {
  handleSignalMessage(event.detail).catch((error) => {
    $("#connectionStatus").textContent = `信令处理失败：${error.message}`;
  });
});

setInterval(() => {
  $("#clock").textContent = formatClock();
}, 77);
setInterval(sampleSenderStats, 1000);
drawSource();
signal.connect();

window.__sender = {
  start: startTransmission,
  applyProfile,
  getState: () => ({
    profileKbps: state.profileKbps,
    started: state.started,
    receiverPresent: state.receiverPresent,
    connectionState: state.pc?.connectionState || "new",
  }),
};
