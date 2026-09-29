const { readPageSource, extractFunction } = require('./helpers/source');
// 扫 minDropCounts：能检出多小的眨眼。用法（包根目录）: node tests/test_min_drop.js
//   能检出多小的眨眼  vs  没有眨眼时每分钟误报几次
const fs = require('fs');
const src = readPageSource('index.html');

const mDetect = [extractFunction(src, 'detect')];
const mMin = src.match(/minDropCounts: (\d+),/);
if (!mDetect || !mMin) throw new Error('没能抽到 detect() 或 minDropCounts');
console.log('抽取真实 detect(): ' + mDetect[0].split('\n').length + ' 行；当前 minDropCounts = ' + mMin[1] + '\n');

const detectFactory = new Function('S', 'config', 'CFG', 'ui', 'setBlinkCount', 'sampleUtc', 'addEvent', 'updateLiveStats', 'pushStats',
  mDetect[0] + '\nreturn detect;');

let seed = 20260920;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 1.0;   // 近似 N(0,~0.58) 形状

const BASE = 2048, BLINK_WIDTH = 150, REFR = 300;

function makeSignal({ minutes, noise, blinkAmp = 0, blinkPeriodMs = 3500 }) {
  const totalMs = minutes * 60000;
  const out = [];
  for (let t = 0; t < totalMs; t += 5) {
    let v = BASE + gauss() * noise * 1.7;
    if (blinkAmp > 0) {
      const ph = t % blinkPeriodMs;
      if (ph < BLINK_WIDTH) v -= blinkAmp * Math.sin(Math.PI * ph / BLINK_WIDTH);
    }
    out.push({ t, v });
  }
  return out;
}

const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length;
  return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };

// 用真实标定算法算阈值，再跑真实 detect()
function run(sig, minDrop, mult, startMs) {
  const config = { refractoryMs: REFR, minWidthMs: 40, maxWidthMs: 800, releaseRatio: 0.45,
                   baselineAlpha: 0.0005, minDropCounts: minDrop, noiseMultiplier: mult, manualThresholdEnabled: false };
  const CFG = { maxEvents: 5000 };
  const ui = { mLast: { textContent: '' } };
  const S = { inBlink: false, thDown: 0, thUp: 0, refractoryUntil: 0, fallingMs: 0, minInBlink: 0,
              dropCounts: 0, baseline: 0, count: 0, events: [], rec: { ev: [] }, session: { config }, shownBpm: null };
  const detect = detectFactory(S, config, CFG, ui, n => { S.count = n; }, () => 0, () => {}, () => {}, () => {});

  // 标定：前 3 秒（跳过前 300ms）
  const calEnd = 3000;
  const cal = sig.filter(s => s.t >= 300 && s.t < calEnd).map(s => s.v);
  const base = median(cal);
  const mad = median(cal.map(v => Math.abs(v - base)));
  const sigma = Math.max(1, 1.4826 * mad);
  const drop = Math.max(minDrop, sigma * mult);
  S.baseline = base; S.dropCounts = drop;
  S.thDown = base - drop; S.thUp = base - drop * config.releaseRatio;

  for (const { t, v } of sig) { if (t >= calEnd && t >= startMs) detect(t, v); }
  return { count: S.count, drop, sigma };
}

const MINUTES = 6;
console.log('=== 一、能检出多小的眨眼（信号噪声固定，看最小可检幅度）===');
for (const noise of [2.5, 5]) {
  console.log(`\n  处理后噪声 sigma≈${noise}：`);
  console.log('    minDrop   实际阈值   可检出的最小眨眼幅度   误报/分钟(无眨眼)');
  for (const minDrop of [18, 15, 12, 10, 8, 6]) {
    // 误报：完全没有眨眼的一段
    const quiet = makeSignal({ minutes: MINUTES, noise, blinkAmp: 0 });
    const fp = run(quiet, minDrop, 4, 0);
    const fpPerMin = fp.count / MINUTES;

    // 最小可检幅度：从 4 往上扫
    let smallest = null;
    for (let amp = 4; amp <= 60; amp += 1) {
      const sig = makeSignal({ minutes: 2, noise, blinkAmp: amp });
      const expected = Math.floor(115000 / 3500);          // 2 分钟里标定后剩余的眨眼数（约）
      const r = run(sig, minDrop, 4, 3000);
      if (r.count >= expected * 0.8) { smallest = amp; break; }
    }
    console.log(`    ${String(minDrop).padStart(6)}   ${fp.drop.toFixed(1).padStart(8)}   ${String(smallest === null ? '>60' : smallest).padStart(18)}   ${fpPerMin.toFixed(2).padStart(16)}`);
  }
}

console.log('\n=== 二、结论 ===');
console.log('  阈值 = max(minDropCounts, 1.4826×MAD×等级4)');
console.log('  噪声 sigma≈2.5 → MAD 项 ≈ 15；sigma≈5 → MAD 项 ≈ 30');
console.log('  所以 sigma≈5 时，minDropCounts 低于 30 就完全不起作用了 —— 那时该调的是等级。');
process.exit(0);
