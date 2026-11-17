/* 界面逻辑: 场景选择、运行仿真、渲染指标/图表/决策表 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // 场景切换时显示/隐藏相关参数
  function syncFields() {
    var s = $('scenario').value;
    document.querySelectorAll('.field[data-for]').forEach(function (el) {
      el.style.display = el.dataset.for.split(' ').indexOf(s) >= 0 ? '' : 'none';
    });
  }
  $('scenario').addEventListener('change', syncFields);
  syncFields();

  function buildTrace() {
    var s = $('scenario').value;
    if (s === 'traceA') return TRACES.TRACE_A;
    if (s === 'traceB') return TRACES.TRACE_B;
    if (s === 'fixed') return TRACES.fixedTrace(+$('baseBw').value, 240);
    return TRACES.dropTrace(+$('baseBw').value, +$('dropBw').value,
      +$('dropStart').value, +$('dropDur').value, 240);
  }

  function renderMetrics(r) {
    var cards = [
      ['切换次数', r.switches + ' (↑' + r.ups + ' ↓' + r.downs + ')'],
      ['起播时间', r.startupDelay.toFixed(2) + ' s'],
      ['卡顿时长', r.stallDuration.toFixed(1) + ' s (' + r.stallEvents + ' 次)'],
      ['最终档位', ABR.BITRATES[r.finalLevel] + ' kbps'],
      ['完成片段', r.segments + ' 片']
    ];
    $('metrics').innerHTML = cards.map(function (c) {
      return '<div class="metric"><div class="k">' + c[0] +
        '</div><div class="v">' + c[1] + '</div></div>';
    }).join('');
  }

  function renderDecisions(r) {
    var rows = r.decisions.map(function (d) {
      var label = d.action === 'up' ? '<span class="up">↑ 升级</span>'
        : d.action === 'down' ? '<span class="down">↓ 降级' + (d.aborted ? '(中止重下)' : '') + '</span>'
        : '<span class="hold">· 保持</span>';
      var cd = d.cooldownLeft > 0.05
        ? '<span class="cd">' + d.cooldownLeft.toFixed(1) + '</span>' : '-';
      return '<tr><td class="l">' + d.now.toFixed(1) + '</td>' +
        '<td class="l">' + label + '</td>' +
        '<td>' + d.bitrate + '</td>' +
        '<td>' + Math.round(d.throughput) + '</td>' +
        '<td>' + d.buffer.toFixed(1) + '</td>' +
        '<td>' + d.jitter.toFixed(2) + '</td>' +
        '<td>' + cd + '</td>' +
        '<td class="l">' + d.reason + '</td></tr>';
    });
    $('decisions').innerHTML = rows.join('');
  }

  // 通用折线图: series = [{data:[[t,v]..], color, step}]
  function drawChart(canvas, series, yMax, markStall) {
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    var padL = 46, padR = 10, padT = 8, padB = 20;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var tMax = 0;
    series.forEach(function (s) {
      s.data.forEach(function (p) { if (p[0] > tMax) tMax = p[0]; });
    });
    tMax = Math.max(tMax, 1);
    function X(t) { return padL + (t / tMax) * plotW; }
    function Y(v) { return padT + plotH - (v / yMax) * plotH; }
    // 网格与坐标
    ctx.strokeStyle = '#22304a'; ctx.fillStyle = '#8a94a8';
    ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var yv = (yMax / 4) * g, y = Y(yv);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(yv >= 1000 ? (yv / 1000) + 'k' : yv.toFixed(0), 6, y + 3);
    }
    for (var gx = 0; gx <= 6; gx++) {
      var tv = (tMax / 6) * gx;
      ctx.fillText(tv.toFixed(0) + 's', X(tv) - 8, H - 6);
    }
    // 卡顿区间标红
    if (markStall) {
      ctx.fillStyle = 'rgba(255,80,80,0.18)';
      var seg = null;
      markStall.forEach(function (p) {
        if (p.stall && seg === null) seg = p.t;
        if (!p.stall && seg !== null) {
          ctx.fillRect(X(seg), padT, X(p.t) - X(seg), plotH); seg = null;
        }
      });
      if (seg !== null) ctx.fillRect(X(seg), padT, X(tMax) - X(seg), plotH);
    }
    // 折线
    series.forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6;
      ctx.beginPath();
      s.data.forEach(function (p, i) {
        var x = X(p[0]), y = Y(p[1]);
        if (i === 0) ctx.moveTo(x, y);
        else if (s.step) { ctx.lineTo(x, Y(s.data[i - 1][1])); ctx.lineTo(x, y); }
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  function renderCharts(r, trace) {
    var bw = r.timeline.map(function (e) { return [e.t, e.bw]; });
    var br = r.timeline.map(function (e) { return [e.t, ABR.BITRATES[e.level]]; });
    drawChart($('chartBw'), [
      { data: bw, color: '#4a82f5', step: true },
      { data: br, color: '#3ecf8e', step: true }
    ], 6000);
    var buf = r.timeline.map(function (e) { return [e.t, e.buffer]; });
    var stall = r.timeline.map(function (e) {
      return { t: e.t, stall: !e.playing && e.t > r.startupDelay };
    });
    drawChart($('chartBuf'), [
      { data: buf, color: '#f0b429' }
    ], ABR.DEFAULTS.maxBuffer, stall);
  }

  function run() {
    var trace = buildTrace();
    var r = ABR.simulate(trace, { numSegments: 60 });
    renderMetrics(r);
    renderCharts(r, trace);
    renderDecisions(r);
  }
  $('run').addEventListener('click', run);
  window.addEventListener('resize', run);
  run();
})();
