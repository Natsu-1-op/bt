const { readPageSource, extractFunction } = require('./helpers/source');
// 实时判决 vs 离线回看：同一份数据必须给出同样的眨眼数。
// 用法（包根目录）: node tests/test_live_offline_consistency.js
//
// 这条测试盯的是一类反复出现的问题：两条判决路径各自算阈值/各自算标定，
// 改动只落在一处，于是「实时」和「回看」结果对不上。
// 已经因此出过两次事故：
//   · 加了 calibrationSkipMs 但离线没跳 -> 两边的标定窗口不一样
//   · 方案 C 的阈值是现场量出来的，离线却自己重算 -> 回看直接显示 0 次眨眼
//   · 标定状态的守卫少验了一个字段（用了 refractory_until_ms 却没验它）
//     -> `t >= undefined` 恒假 -> 静默判出 0 次眨眼，而且不报错不报警（见第五节）
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

function grab(name) { return extractFunction(src, name); }
const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length;
  return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
const CFG = { sampleRateHz: 200, noiseDetrendWindowMs: 500, adcMax: 4095, maxEvents: 5000 };
const robustNoise = new Function('CFG', 'median', grab('median') + '\n' + grab('robustNoise') + '\nreturn robustNoise;')(CFG, median);
const makeOfflineDetector = new Function('median', 'robustNoise', grab('makeOfflineDetector') + '\nreturn makeOfflineDetector;')(median, robustNoise);

// ---- 造信号 ----
let seed = 20260922;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;

function synth({ seconds = 30, noise = 1, blinks = [10, 12, 30, 8, 25], periodMs = 1500, base = 2048 }) {
  const rows = [];
  let t = 0;
  const total = seconds * 1000;
  for (let i = 0; i < total / 5; i++) {
    t += 5;
    let v = base + noise * gauss();
    const ph = t % periodMs;
    if (ph < 150 && blinks.length) {
      const amp = blinks[Math.floor(t / periodMs) % blinks.length];
      v -= amp * Math.sin(Math.PI * ph / 150);
    }
    rows.push([t, t, t, Math.round(v), Math.round(v), 0, 0]);
  }
  return rows;
}

// ---- 实时路径：用真实的 detect() ----
// ⚠️ 两处必须和 App 一致，否则测出来的是测试自己的偏差而不是真分歧：
//   1) 实时也要过同一个 8 点滑动平均（onSample 里 filt = pushMA(raw)）
//   2) 标定起点是【第一个样本】的时间，不是绝对 300ms（onSample 里 calStartMs 就是这么定的）
function runLive(rows, drop) {
  const config = {
    maLength: 8, refractoryMs: 300, minWidthMs: 40, maxWidthMs: 800, releaseRatio: 0.45,
    baselineAlpha: 0.0005, calibrationMs: 3000, calibrationSkipMs: 300,
    minDropCounts: 12, noiseMultiplier: 4, manualThresholdEnabled: false,
  };
  const ma = []; let maSum = 0;
  const pushMA = v => { ma.push(v); maSum += v; if (ma.length > config.maLength) maSum -= ma.shift(); return maSum / ma.length; };
  const filtOf = new Map();
  for (const r of rows) filtOf.set(r[0], pushMA(r[3]));

  const S = { phase: 'RUN', inBlink: false, thDown: 0, thUp: 0, refractoryUntil: 0, fallingMs: 0,
              minInBlink: 0, dropCounts: drop, baseline: 0, count: 0, events: [], rec: { ev: [] },
              session: { config }, shownBpm: null };
  const ui = { mLast: { textContent: '' } };
  const detect = new Function('S', 'config', 'CFG', 'ui', 'setBlinkCount', 'sampleUtc', 'addEvent',
    'updateLiveStats', 'pushStats', grab('detect') + '\nreturn detect;')(
    S, config, CFG, ui, n => { S.count = n; }, () => 0, () => {}, () => {}, () => {});

  const calStart = rows[0][0];
  const cal = rows.filter(r => (r[0] - calStart) >= config.calibrationSkipMs && (r[0] - calStart) < config.calibrationMs)
                  .map(r => filtOf.get(r[0]));
  S.baseline = median(cal);
  S.thDown = S.baseline - drop; S.thUp = S.baseline - drop * config.releaseRatio;
  for (const r of rows) if (r[0] - calStart >= config.calibrationMs) detect(r[0], filtOf.get(r[0]));
  return S.count;
}

// ---- 离线路径：用真实的 makeOfflineDetector() ----
function runOffline(rows, drop) {
  const config = {
    maLength: 8, refractoryMs: 300, minWidthMs: 40, maxWidthMs: 800, releaseRatio: 0.45,
    baselineAlpha: 0.0005, calibrationMs: 3000, calibrationSkipMs: 300,
    minDropCounts: 12, noiseMultiplier: 4, manualThresholdEnabled: false, blinkCalEnabled: true,
  };
  const detector = makeOfflineDetector(config, drop);
  let n = 0;
  for (const r of rows) if (detector(r)) n++;
  return n;
}

let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };

console.log('=== 一、同一个阈值下，实时与离线必须一致 ===\n');
for (const drop of [12, 10, 8, 7, 6]) {
  for (const noise of [1, 2.5]) {
    const rows = synth({ noise, blinks: [9, 11, 30, 8, 25, 14] });
    const live = runLive(rows, drop), off = runOffline(rows, drop);
    chk(live === off, `阈值 ${drop}、σ=${noise}：实时 ${live} / 离线 ${off}`, live === off ? '一致' : '不一致！');
  }
}

console.log('\n=== 二、不传已定阈值时，离线退回自己重算（旧行为，仍要能跑）===\n');
{
  const rows = synth({ noise: 1, blinks: [30, 35, 28] });
  const off = runOffline(rows, null);
  chk(Number.isFinite(off) && off > 0, '不传阈值时仍能正常判决', `${off} 次`);
}

console.log('\n=== 三、方案 C 的场景：浅眨眼 + 低阈值 ===\n');
{
  // 这是真实出过的事故：实时用方案 C 定出阈值 7，检出了 3 次浅眨眼；
  // 离线却自己重算成 max(12, 4σ)=12，于是一个都检不出 —— 回看显示 0 次。
  const rows = synth({ noise: 1, blinks: [10, 11, 9, 30] });
  const live = runLive(rows, 7), offFixed = runOffline(rows, 7), offAuto = runOffline(rows, null);
  console.log(`  实时（阈值 7）: ${live} 次   离线传阈值 7: ${offFixed} 次   离线自己重算: ${offAuto} 次`);
  chk(live === offFixed, '传了实时阈值时两边一致');
  chk(offAuto < offFixed, '不传阈值时离线会漏掉浅眨眼（复现原事故）', `${offAuto} < ${offFixed}`);
}

console.log('\n=== 四、analyze() 确实把实时阈值传下去了 ===\n');
{
  const calls = src.match(/makeOfflineDetector\(session\.config, liveDrop, session\.blink_calibration\)/g) || [];
  const liveDropDef = src.match(/const liveDrop = session\.blink_calibration/);
  chk(calls.length === 1, 'analyze() 传了 liveDrop', String(calls.length));
  chk(!!liveDropDef, 'liveDrop 取自会话里记录的 blink_calibration.threshold');
  chk(/Number\.isFinite\(session\.blink_calibration\.threshold\)/.test(src), '取阈值前做了有限性检查');
  chk(/const session = S\.session \? JSON\.parse\(JSON\.stringify\(S\.session\)\)/.test(src), '分析使用稳定会话快照');
}

console.log('\n=== 五、方案 C 标定状态：字段不全必须退回，不能静默判 0 ===\n');
{
  // 事故原型：makeOfflineDetector 的守卫只检查了 end_timeline_ms 和 run_baseline，
  // 但函数体还用 refractory_until_ms。少这个字段 → refractoryUntil = undefined
  // → `t >= undefined` 恒假 → 一次眨眼都判不出来，而且**不报错、不报警**。
  // 这类"静默 0 次"比崩溃危险得多：回看显示 0 次，看起来像"这人真的没眨眼"。
  function runOfflineWithCal(rows, drop, cal) {
    const config = {
      maLength: 8, refractoryMs: 300, minWidthMs: 40, maxWidthMs: 800, releaseRatio: 0.45,
      baselineAlpha: 0.0005, calibrationMs: 3000, calibrationSkipMs: 300,
      minDropCounts: 12, noiseMultiplier: 4, manualThresholdEnabled: false, blinkCalEnabled: true,
    };
    const detector = makeOfflineDetector(config, drop, cal);
    let n = 0;
    for (const r of rows) if (detector(r)) n++;
    return n;
  }
  const rows = synth({ seconds: 40, noise: 1, blinks: [20, 22, 30, 18] });
  const complete = { end_timeline_ms: 10000, run_baseline: 2048, refractory_until_ms: 10300, threshold: 8 };
  const nFull = runOfflineWithCal(rows, 8, complete);
  const nNoCal = runOfflineWithCal(rows, 8, null);
  chk(nFull > 0, '标定状态完整时能正常判决', `${nFull} 次`);
  chk(nFull < nNoCal, '标定窗口内的眨眼被排除掉', `${nFull} < ${nNoCal}`);

  for (const [missing, cal] of [
    ['refractory_until_ms', { end_timeline_ms: 10000, run_baseline: 2048, threshold: 8 }],
    ['run_baseline',        { end_timeline_ms: 10000, refractory_until_ms: 10300, threshold: 8 }],
    ['end_timeline_ms',     { run_baseline: 2048, refractory_until_ms: 10300, threshold: 8 }],
  ]) {
    const n = runOfflineWithCal(rows, 8, cal);
    chk(n > 0, `缺 ${missing} 时退回常规标定，而不是静默 0 次`, `${n} 次`);
  }
  // threshold 缺失 + 没传 fixedDrop → drop = undefined → thDown = NaN，同样是静默 0 次
  const nNoThreshold = runOfflineWithCal(rows, null, { end_timeline_ms: 10000, run_baseline: 2048, refractory_until_ms: 10300 });
  chk(nNoThreshold > 0, 'threshold 缺失且未传固定阈值时退回常规标定', `${nNoThreshold} 次`);
  const regular=runOfflineWithCal(rows,null,null);
  chk(nNoThreshold===regular,'无阈值时必须从记录开头走常规标定，不能先吞掉旧标定窗口',`${nNoThreshold} vs ${regular}`);
}

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
