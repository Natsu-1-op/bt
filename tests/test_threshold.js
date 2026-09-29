const { readPageSource, extractFunction } = require('./helpers/source');
// 阈值下限与抗干扰等级的实测关系。
// 用法（在包根目录下）:  node tests/test_threshold.js
// 结论：信号干净时阈值恒为 minDropCounts(18)，改等级不起作用；
// 阈值 = max(minDropCounts=18, 1.4826 × MAD × 等级)
const fs = require('fs');
const src = readPageSource('index.html');

const mCal = src.match(/if \(t - S\.calStartMs >= CFG\.calibrationSkipMs\) S\.cal\.push\(filt\);/);
const mBase = src.match(/const base = median\(S\.cal\);/);
const mDrop = src.match(/const mad = median\(S\.cal\.map\(v => Math\.abs\(v - base\)\)\);[\s\S]*?sigma \* config\.noiseMultiplier\);/);
const mNoise = [extractFunction(src, 'robustNoise')];
const mMinDrop = src.match(/minDropCounts: (\d+),/);
if (!mCal || !mBase || !mDrop || !mMinDrop || !mNoise) throw new Error('没能抽全真实代码');
const MIN_DROP = Number(mMinDrop[1]);
console.log('真实代码：阈值 = max(' + MIN_DROP + ', 1.4826 × MAD × 等级)   标定 3s，取样跳过前 300ms\n');

const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length;
  return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
// σ 现在是去漂移的 robustNoise —— 测试也要用它，否则算出来的阈值和线上不一样。
const robustNoise = new Function('CFG', 'median',
  mNoise[0] + '\nreturn robustNoise;')({ sampleRateHz: 200, noiseDetrendWindowMs: 500 }, median);
const dropFn = new Function('S', 'config', 'median', 'robustNoise', 'calibrationDrift',
  mBase[0] + '\n' + mDrop[0] + '\nreturn { base, mad, sigma, drop };');

let seed = 20260920;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const synth = (noise, transient, totalMs = 3000) => {
  const out = [];
  for (let t = 0; t < totalMs; t += 5) {
    let v = 2048 + (rnd() + rnd() + rnd() + rnd() - 2) * noise;
    if (transient && t < transient.ms) v += transient.amp;
    out.push({ t, filt: v });
  }
  return out;
};
function calibrate(samples, skipMs, mult) {
  const CFG = { calibrationSkipMs: skipMs };
  const config = { manualThresholdEnabled: false, minDropCounts: MIN_DROP, noiseMultiplier: mult };
  const S = { cal: [], calStartMs: null };
  for (const { t, filt } of samples) { if (S.calStartMs === null) S.calStartMs = t; eval(mCal[0]); }
  return { ...dropFn(S, config, median, robustNoise, () => 0), n: S.cal.length };
}

console.log('=== 一、等级 2 vs 4：什么时候真的有区别 ===');
console.log('  噪声sigma   等级2阈值   等级4阈值   差值   谁在决定阈值');
const noiseLevels = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30];
const rows = [];
for (const nz of noiseLevels) {
  const s = synth(nz, null);
  const a = calibrate(s, 300, 2), b = calibrate(s, 300, 4);
  const who = (a.drop > MIN_DROP + 0.01 && b.drop > MIN_DROP + 0.01) ? 'MAD'
            : (a.drop <= MIN_DROP + 0.01 && b.drop <= MIN_DROP + 0.01) ? '下限' : '混合';
  rows.push({ nz, a, b, who });
  console.log(`  ${String(nz).padStart(8)}   ${a.drop.toFixed(1).padStart(9)}   ${b.drop.toFixed(1).padStart(9)}   ${(b.drop - a.drop).toFixed(1).padStart(5)}   ${who}`);
}

console.log('\n=== 二、标定跳过前 300ms 对阈值的影响 ===');
const scenarios = [
  ['无扰动',            null,                     4],
  ['100ms 尖峰 +400',   { ms: 100, amp: 400 },    4],
  ['300ms 尖峰 +400',   { ms: 300, amp: 400 },    4],
  ['500ms 台阶 +150',   { ms: 500, amp: 150 },    4],
  ['500ms 台阶 +150（噪声大 sigma≈15）', { ms: 500, amp: 150 }, 15],
  ['800ms 台阶 +150（噪声大 sigma≈15）', { ms: 800, amp: 150 }, 15],
];
for (const [name, tr, nz] of scenarios) {
  const s = synth(nz, tr);
  const off = calibrate(s, 0, 2), on = calibrate(s, 300, 2);
  console.log(`  ${name}`);
  console.log(`    不跳过 阈值=${off.drop.toFixed(1)} (sigma=${off.sigma.toFixed(2)})   跳过 阈值=${on.drop.toFixed(1)} (sigma=${on.sigma.toFixed(2)})   差 ${(off.drop - on.drop).toFixed(1)}`);
}

console.log('\n=== 结论 ===');
const cross2 = rows.find(r => r.a.drop > MIN_DROP + 0.01);
const cross4 = rows.find(r => r.b.drop > MIN_DROP + 0.01);
console.log(`  等级 2 要 sigma > ${(MIN_DROP / (1.4826 * 2)).toFixed(1)} 才开始超过下限`);
console.log(`  等级 4 要 sigma > ${(MIN_DROP / (1.4826 * 4)).toFixed(1)} 才开始超过下限`);
console.log(`  实测：等级2 在 sigma=${cross2 ? cross2.nz : '-'} 起生效，等级4 在 sigma=${cross4 ? cross4.nz : '-'} 起生效`);
console.log('');
console.log('  也就是说：信号干净（sigma 小）时，改等级完全没用 —— 阈值卡在 18 这个下限上。');
console.log('  想提高对小信号的灵敏度，要动的是 minDropCounts(18)，不是等级。');

let bad = 0;
const chk = (ok, m) => { console.log(`  ${ok ? '✓' : '✗'} ${m}`); if (!ok) bad++; };
chk(rows[0].a.drop === MIN_DROP && rows[0].b.drop === MIN_DROP, '干净信号下等级 2 和 4 的阈值相同（都等于下限）');
chk(cross2 && cross2.nz >= 8, '等级 2 确实比等级 4 需要更大噪声才生效（更灵敏）');
chk(cross2 && cross4 && cross2.nz > cross4.nz, '等级2 比等级4 灵敏，交叉点更靠后');
console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 通过');
process.exit(bad ? 1 : 0);
