// 真实 WebRTC loopback 数据源：本端 canvas 推流 -> 本端接收，
// 周期性 getStats 采集接收端 inbound-rtp 视频指标。
// 故障注入：带宽下降 = 限制发送端 maxBitrate；主线程阻塞 = busy loop。
import { extractInboundVideo, diffSample } from "./stats-normalize.js";

export class LoopbackSource {
  constructor({ dtMs = 500 } = {}) {
    this.dtMs = dtMs;
    this.pcSend = null;
    this.pcRecv = null;
    this.sender = null;
    this.prevRaw = null;
    this.timer = null;
    this.blockTimer = null;
    this.t = 0;
  }

  async start(onSample) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    const drawFrame = () => {
      ctx.fillStyle = "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#fff";
      ctx.fillText(new Date().toLocaleTimeString(), 20, 120);
    };
    this.animTimer = setInterval(drawFrame, 66);
    const stream = canvas.captureStream(30);

    this.pcSend = new RTCPeerConnection();
    this.pcRecv = new RTCPeerConnection();
    this.pcSend.onicecandidate = (e) => e.candidate && this.pcRecv.addIceCandidate(e.candidate);
    this.pcRecv.onicecandidate = (e) => e.candidate && this.pcSend.addIceCandidate(e.candidate);
    this.sender = this.pcSend.addTrack(stream.getVideoTracks()[0], stream);

    const offer = await this.pcSend.createOffer();
    await this.pcSend.setLocalDescription(offer);
    await this.pcRecv.setRemoteDescription(offer);
    const answer = await this.pcRecv.createAnswer();
    await this.pcRecv.setLocalDescription(answer);
    await this.pcSend.setRemoteDescription(answer);

    this.timer = setInterval(async () => {
      this.t += this.dtMs;
      const stats = await this.pcRecv.getStats();
      const raw = extractInboundVideo(stats, this.prevRaw);
      if (!raw) return;
      if (this.prevRaw) onSample(diffSample(this.prevRaw, raw, this.t));
      this.prevRaw = raw;
    }, this.dtMs);
  }

  // 带宽下降：压低编码码率，诱发接收端丢帧/卡顿
  async injectBandwidth(durationMs = 20000) {
    if (!this.sender) return;
    const params = this.sender.getParameters();
    const saved = JSON.parse(JSON.stringify(params.encodings || [{}]));
    params.encodings = params.encodings || [{}];
    params.encodings.forEach((e) => { e.maxBitrate = 60000; });
    await this.sender.setParameters(params);
    setTimeout(async () => {
      const p = this.sender.getParameters();
      p.encodings = saved;
      await this.sender.setParameters(p).catch(() => {});
    }, durationMs);
  }

  // 主线程阻塞：周期性 busy loop，延迟解码回调与渲染
  injectMainThreadBlock(durationMs = 20000, blockMs = 220, everyMs = 500) {
    const stopAt = performance.now() + durationMs;
    this.blockTimer = setInterval(() => {
      if (performance.now() > stopAt) {
        clearInterval(this.blockTimer);
        return;
      }
      const end = performance.now() + blockMs;
      while (performance.now() < end) { /* busy wait */ }
    }, everyMs);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.animTimer);
    clearInterval(this.blockTimer);
    if (this.pcSend) this.pcSend.close();
    if (this.pcRecv) this.pcRecv.close();
  }
}
