// Node test harness for the DSP core (js/dsp.js) using the shared synthetic
// signals (js/testsignals.js). Writes artifacts/test-results.json.
// Run: node tests/run-tests.cjs
'use strict';

const path = require('path');
const fs = require('fs');
const DSP = require('../js/dsp.js');
const TestSignals = require('../js/testsignals.js');

const results = [];
let failures = 0;

function check(name, actual, predicate, expectedText) {
  const ok = predicate(actual);
  if (!ok) failures++;
  results.push({
    name,
    actual: typeof actual === 'number' ? +actual.toFixed(4) : actual,
    expected: expectedText,
    pass: ok
  });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  => ' +
    (typeof actual === 'number' ? actual.toFixed(4) : JSON.stringify(actual)) +
    '  (期望: ' + expectedText + ')');
}

function analyze(sig, targetLUFS) {
  const sr = sig.sampleRate;
  const weighted = sig.channels.map(c => DSP.kWeight(c, sr));
  const weights = sig.channels.map(() => 1);
  const integrated = DSP.integratedLoudness(weighted, sr, weights);
  const tp = DSP.truePeak(sig.channels, sr);
  const clips = DSP.findClipCandidates(sig.channels, sr);
  const gain = DSP.gainToTarget(integrated.integrated, targetLUFS);
  return { integrated: integrated.integrated, tp, clips, gain };
}

const TARGET = -16;

// ---- 0. K-weighting coefficients at 48 kHz vs published BS.1770 values ----
const c48 = DSP.kWeightingCoeffs(48000);
check('K加权 stage1 b0 ≈ 1.5351', c48.stage1.b[0], v => Math.abs(v - 1.53512485958697) < 1e-3, '1.5351±0.001');
check('K加权 stage2 a1 ≈ -1.9900', c48.stage2.a[1], v => Math.abs(v - -1.99004745483398) < 1e-3, '-1.9900±0.001');

// ---- 1. 合成正弦（含 1 s 静音段）----
const sine = TestSignals.sineWithSilence(48000, 6);
const ra = analyze(sine, TARGET);
check('正弦 积分响度 ≈ -20 LUFS', ra.integrated, v => Math.abs(v - -20.3) < 0.4, '-20.3±0.4 LUFS');
check('正弦 真峰值 ≈ -20 dBTP', ra.tp[0].dBTP, v => Math.abs(v - -20) < 0.1, '-20±0.1 dBTP');
check('正弦 增益建议 ≈ +4.3 dB 且未钳制', ra.gain.gainDb, v => Math.abs(v - 4.3) < 0.4, '+4.3±0.4 dB');
check('正弦 增益适用', ra.gain.applicable, v => v === true, 'true');
check('正弦 无削波候选', ra.clips.length, v => v === 0, '0');
// 静音段不应显著拉低积分响度：与无静音版本对比
const noGap = { sampleRate: 48000, channels: sine.channels.map(c => Float64Array.from(c)) };
for (let ch = 0; ch < 2; ch++) {
  for (let i = Math.round(2.5 * 48000); i < Math.round(3.5 * 48000); i++) {
    noGap.channels[ch][i] = Math.pow(10, -20 / 20) * Math.sin(2 * Math.PI * 1000 * i / 48000);
  }
}
const raNoGap = analyze(noGap, TARGET);
check('静音段被门控（与无静音差 < 0.5 LU）', Math.abs(ra.integrated - raNoGap.integrated), v => v < 0.5, '< 0.5 LU');

// ---- 2. 瞬时脉冲 ----
const imp = TestSignals.impulses(48000, 4);
const rb = analyze(imp, TARGET);
// 削波平台边缘的带限重建会产生采样间过冲，真峰值应高于 0 dBTP
check('脉冲 真峰值检出采样间过冲 > 0.5 dBTP', rb.tp[0].dBTP, v => v > 0.5 && v < 2.0, '0.5..2 dBTP');
check('脉冲 检测到削波候选', rb.clips.length, v => v >= 2, '>= 2');
check('脉冲 3s 处平台被标记', rb.clips.some(s => Math.abs(s.startSec - 3.0) < 0.01 && s.lengthSamples >= 8), v => v === true, 'true');
check('脉冲 积分响度有限但很低', rb.integrated, v => isFinite(v) && v < -30, '有限且 < -30 LUFS');
check('脉冲 增益有限且未越界', rb.gain.gainDb, v => isFinite(v) && Math.abs(v) <= DSP.MAX_SUGGESTED_GAIN_DB, '|gain| <= 60 dB');

// ---- 3. 左右不对称 ----
const asym = TestSignals.asymmetric(48000, 5);
const rc = analyze(asym, TARGET);
check('不对称 左声道真峰值 ≈ -14 dBTP', rc.tp[0].dBTP, v => Math.abs(v - -14) < 0.15, '-14±0.15 dBTP');
check('不对称 右声道真峰值过冲 > 0.5 dBTP', rc.tp[1].dBTP, v => v > 0.5 && v < 2.0, '0.5..2 dBTP');
check('不对称 削波仅在右声道(4s)', rc.clips.every(s => s.channel === 1 && Math.abs(s.startSec - 4.0) < 0.01), v => v === true, 'true');
check('不对称 积分响度介于 -19~-15 LUFS', rc.integrated, v => v > -19 && v < -15, '-19..-15 LUFS');

// ---- 4. 纯静音：绝不能产生极端增益 ----
const silence = { sampleRate: 48000, channels: [new Float64Array(48000 * 3), new Float64Array(48000 * 3)] };
const rd = analyze(silence, TARGET);
check('静音 积分响度 = -∞', rd.integrated, v => v === -Infinity, '-Infinity');
check('静音 增益不适用', rd.gain.applicable, v => v === false, 'false');
check('静音 增益为 null', rd.gain.gainDb, v => v === null, 'null');

// ---- 5. 采样率不一致：44.1k / 96k 与 48k 结果可比 ----
const s44 = analyze(TestSignals.sineWithSilence(44100, 6), TARGET);
const s96 = analyze(TestSignals.sineWithSilence(96000, 6), TARGET);
check('44.1kHz 积分响度与 48k 差 < 0.3 LU', Math.abs(s44.integrated - ra.integrated), v => v < 0.3, '< 0.3 LU');
check('96kHz 积分响度与 48k 差 < 0.3 LU', Math.abs(s96.integrated - ra.integrated), v => v < 0.3, '< 0.3 LU');

// ---- 6. 单声道 vs 立体声：同信号单声道低约 3 LU ----
const mono = { sampleRate: 48000, channels: [sine.channels[0]] };
const re = analyze(mono, TARGET);
check('单声道比立体声低约 3 LU', ra.integrated - re.integrated, v => Math.abs(v - 3.01) < 0.1, '3.01±0.1 LU');

// ---- export ----
const outDir = path.join(__dirname, '..', 'artifacts');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const report = {
  tool: 'offline-loudness-analyzer DSP core tests',
  date: new Date().toISOString(),
  targetLUFS: TARGET,
  summary: {
    sine: { integratedLUFS: +ra.integrated.toFixed(3), truePeakDbTP: +ra.tp[0].dBTP.toFixed(3), suggestedGainDb: +ra.gain.gainDb.toFixed(3) },
    impulses: { integratedLUFS: +rb.integrated.toFixed(3), truePeakDbTP: +rb.tp[0].dBTP.toFixed(3), clipSpans: rb.clips.length },
    asymmetric: { integratedLUFS: +rc.integrated.toFixed(3), truePeakL: +rc.tp[0].dBTP.toFixed(3), truePeakR: +rc.tp[1].dBTP.toFixed(3), clipSpans: rc.clips.length },
    silence: { integratedLUFS: null, gainApplicable: rd.gain.applicable },
    sampleRateCheck: { at44100: +s44.integrated.toFixed(3), at48000: +ra.integrated.toFixed(3), at96000: +s96.integrated.toFixed(3) }
  },
  checks: results
};
fs.writeFileSync(path.join(outDir, 'test-results.json'), JSON.stringify(report, null, 2));
console.log('\n结果已写入 artifacts/test-results.json');
console.log(failures === 0 ? '全部通过 (' + results.length + ' 项)' : failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
