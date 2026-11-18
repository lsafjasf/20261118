/* 程序化运动场景：确定性渲染，frameIndex 相同则画面完全相同。
 * 画面包含三类典型区域，用于分区评估编码质量：
 *  - flat    平坦区域：左上角纯色天空
 *  - motion  运动区域：沿利萨茹轨迹高速移动的纹理方块
 *  - highfreq 高频细节：右下角细密条纹
 */
(function (global) {
  const W = 640, H = 360, FPS = 30, FRAMES = 150;

  const FLAT_RECT = { x: 16, y: 16, w: 280, h: 96 };
  const HF_RECT = { x: 400, y: 200, w: 224, h: 144 };
  const MOTION_SIZE = 96;

  function motionCenter(t) {
    const cx = W / 2 + Math.sin(t * 0.11) * 190;
    const cy = 150 + Math.sin(t * 0.23 + 1.3) * 78;
    return { x: cx, y: cy };
  }

  function getRegions(frameIndex) {
    const c = motionCenter(frameIndex);
    return {
      flat: FLAT_RECT,
      highfreq: HF_RECT,
      motion: {
        x: Math.round(c.x - MOTION_SIZE / 2),
        y: Math.round(c.y - MOTION_SIZE / 2),
        w: MOTION_SIZE,
        h: MOTION_SIZE,
      },
    };
  }

  function renderFrame(ctx, t) {
    // 背景：缓慢变化的暗色渐变（运动区域之外整体低纹理）
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const shift = Math.sin(t * 0.02) * 8;
    g.addColorStop(0, `rgb(${34 + shift},${40 + shift},${52 + shift})`);
    g.addColorStop(1, "rgb(16,19,26)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 远景缓慢平移的圆点，提供中等运动量
    ctx.fillStyle = "rgba(120,140,170,0.35)";
    for (let i = 0; i < 24; i++) {
      const px = (i * 97 + t * 1.5) % (W + 40) - 20;
      const py = 130 + ((i * 53) % 200);
      ctx.beginPath();
      ctx.arc(px, py, 3 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    }

    // 平坦区域：纯色块（无任何纹理）
    ctx.fillStyle = "rgb(70,116,158)";
    ctx.fillRect(FLAT_RECT.x, FLAT_RECT.y, FLAT_RECT.w, FLAT_RECT.h);

    // 高频细节区域：2px 竖条纹 + 轻微滚动，考验细节保留
    ctx.save();
    ctx.beginPath();
    ctx.rect(HF_RECT.x, HF_RECT.y, HF_RECT.w, HF_RECT.h);
    ctx.clip();
    const scroll = Math.floor(t / 4) % 4;
    for (let x = HF_RECT.x - 4; x < HF_RECT.x + HF_RECT.w + 4; x += 4) {
      ctx.fillStyle = ((x + scroll) / 4) % 2 === 0 ? "rgb(205,210,220)" : "rgb(30,34,44)";
      ctx.fillRect(x + scroll, HF_RECT.y, 2, HF_RECT.h);
    }
    ctx.restore();

    // 运动物体：带渐变与文字的方块，快速移动
    const c = motionCenter(t);
    const mx = c.x - MOTION_SIZE / 2, my = c.y - MOTION_SIZE / 2;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.sin(t * 0.05) * 0.25);
    const og = ctx.createLinearGradient(-48, -48, 48, 48);
    og.addColorStop(0, "rgb(240,120,60)");
    og.addColorStop(1, "rgb(160,40,120)");
    ctx.fillStyle = og;
    ctx.fillRect(-48, -48, MOTION_SIZE, MOTION_SIZE);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("AV1", 0, 0);
    ctx.restore();
    void mx; void my;

    // 帧号水印（便于核对解码帧序号）
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(String(t).padStart(3, "0"), 6, H - 18);
  }

  global.Scene = { W, H, FPS, FRAMES, renderFrame, getRegions };
})(window);
