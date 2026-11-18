export function buildLayout(root: HTMLElement): void {
  root.innerHTML = `
  <header>
    <h1>绿幕抠像工作台</h1>
    <span>TypeScript · Canvas 2D · WebCodecs — 色度距离软遮罩 / 去溢色 / 歧义保护</span>
  </header>
  <div class="layout">
    <div>
      <section class="panel">
        <h2>抠像参数</h2>
        <div class="control">
          <label>背景采样色 <span class="row" style="flex:0 0 auto"><i class="swatch" id="swatch"></i><b id="keyRgb"></b></span></label>
          <div class="row">
            <button id="sampleBtn">框选采样模式</button>
            <button id="autoBtn">自动采样</button>
          </div>
        </div>
        <div class="control">
          <label>容差 <b id="tolVal"></b></label>
          <input type="range" id="tolerance" min="0" max="80" step="1" />
        </div>
        <div class="control">
          <label>软边宽度 <b id="softVal"></b></label>
          <input type="range" id="softness" min="0" max="90" step="1" />
        </div>
        <div class="control">
          <label>去溢色强度 <b id="despillVal"></b></label>
          <input type="range" id="despill" min="0" max="1" step="0.05" />
        </div>
        <div class="control">
          <label>歧义 alpha 下限 <b id="floorVal"></b></label>
          <input type="range" id="ambiguityFloor" min="0" max="255" step="5" />
        </div>
      </section>

      <section class="panel">
        <h2>保护区域</h2>
        <div class="row">
          <button id="protectBtn">涂抹保护</button>
          <button id="clearProtectBtn">清除</button>
        </div>
        <div class="warn-box" id="warnBox"></div>
      </section>

      <section class="panel">
        <h2>输出背景</h2>
        <select id="bgMode">
          <option value="checker">透明棋盘格</option>
          <option value="gradient">蓝紫渐变</option>
          <option value="solid">纯色（洋红）</option>
        </select>
      </section>

      <section class="panel">
        <h2>视频导出 / 解码抽查</h2>
        <button class="primary" id="exportBtn">导出合成视频并解码抽查</button>
        <div class="status" id="exportStatus"></div>
        <div class="decode-strip" id="decodeStrip"></div>
      </section>
    </div>

    <div>
      <div class="canvas-grid">
        <div class="canvas-card"><h3>原帧 <small>黄=歧义 / 红=保护</small></h3><canvas id="cvOriginal"></canvas></div>
        <div class="canvas-card"><h3>软遮罩 <small>黄=歧义像素</small></h3><canvas id="cvMatte"></canvas></div>
        <div class="canvas-card"><h3>换背景合成 <small>去溢色后</small></h3><canvas id="cvComposite"></canvas></div>
      </div>
      <div class="timeline">
        <button id="playBtn">播放</button>
        <input type="range" id="frameSlider" min="0" step="1" />
        <span id="frameLabel"></span>
      </div>
      <section class="panel" style="margin-top:12px">
        <h2>质量指标（参考遮罩来自合成素材真值）</h2>
        <div class="metrics" id="metricsBox"></div>
      </section>
    </div>
  </div>`;
}
