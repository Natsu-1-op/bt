const { readPageSource, extractFunction } = require('./helpers/source');
// 量 minDropCounts 的误报率（90 分钟静默信号）。用法（包根目录）: node tests/test_false_positive.js
const fs = require('fs');
const src = readPageSource('index.html');
const mDetect = [extractFunction(src, 'detect')];
const detectFactory = new Function('S', 'config', 'CFG', 'ui', 'setBlinkCount', 'sampleUtc', 'addEvent', 'updateLiveStats', 'pushStats',
  mDetect[0] + '\nreturn detect;');

let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;
const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length;
  return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };

function runQuiet(minutes, noise, minDrop, mult) {
  const config = { refractoryMs: 300, minWidthMs: 40, maxWidthMs: 800, releaseRatio: 0.45,
                   baselineAlpha: 0.0005, minDropCounts: minDrop, noiseMultiplier: mult, manualThresholdEnabled: false };
  const CFG = { maxEvents: 5000 };
  const ui = { mLast: { textContent: '' } };
  const S = { inBlink: false, thDown: 0, thUp: 0, refractoryUntil: 0, fallingMs: 0, minInBlink: 0,
              dropCounts: 0, baseline: 0, count: 0, events: [], rec: { ev: [] }, session: { config }, shownBpm: null };
  const detect = detectFactory(S, config, CFG, ui, n => { S.count = n; }, () => 0, () => {}, () => {}, () => {});

  const cal = [];
  for (let t = 0; t < 3000; t += 5) if (t >= 300) cal.push(2048 + gauss() * noise);
  const base = median(cal);
  const sigma = Math.max(1, 1.4826 * median(cal.map(v => Math.abs(v - base))));
  const drop = Math.max(minDrop, sigma * mult);
  S.baseline = base; S.dropCounts = drop; S.thDown = base - drop; S.thUp = base - drop * config.releaseRatio;

  const totalMs = minutes * 60000;
  for (let t = 3000; t < totalMs; t += 5) detect(t, 2048 + gauss() * noise);
  return { count: S.count, drop, sigma };
}

console.log('=== 30 分钟无眨眼信号，误报次数（等级固定 4）===\n');
for (const noise of [2.5, 5]) {
  console.log(`  处理后噪声 sigma≈${noise}`);
  console.log('    minDrop   实际阈值   30 分钟误报次数   误报/分钟');
  for (const minDrop of [18, 15, 12, 10, 8]) {
    let tot = 0, dropSum = 0;
    const REPEAT = 3;                      // 换随机种子重复 3 次，共 90 分钟
    for (let k = 0; k < REPEAT; k++) { seed = 777 + k * 131; const r = runQuiet(30, noise, minDrop, 4); tot += r.count; dropSum += r.drop; }
    console.log(`    ${String(minDrop).padStart(6)}   ${(dropSum / REPEAT).toFixed(1).padStart(8)}   ${String(tot).padStart(15)}   ${(tot / (30 * REPEAT)).toFixed(3).padStart(9)}`);
  }
  console.log('');
}
console.log('  注：噪声模型是 4 个均匀分布之和，尾部比真实 ADC 噪声轻，');
console.log('      实际误报率只会比这里更高，不会更低 —— 所以留一点余量是必要的。');
