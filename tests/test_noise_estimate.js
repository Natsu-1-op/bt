const { readPageSource, extractFunction } = require('./helpers/source');
// 噪声估计与电极漂移监测的测试。用法（包根目录）: node tests/test_noise_estimate.js
//
// 起因：σ 原本是拿 |样本 − 基线| 的中位数算的，把【慢漂移】也算成了噪声。
// 实测一段标定窗口 3 秒内漂了 7 counts，σ 就从 1.93 虚涨到 3.89，
// 阈值跟着抬高，浅眨眼全被漏掉。而漂移来自电极整定/运动/呼吸，跟电磁干扰无关。
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

function grab(name) { return extractFunction(src, name); }
function grabMedian() { return extractFunction(src, 'median'); }

const CFG = { sampleRateHz: 200, noiseDetrendWindowMs: 500, calibrationDriftWarnCounts: 5 };
const api = new Function('CFG', grabMedian() + '\n' + grab('robustNoise') + '\n' + grab('calibrationDrift') +
  '\nreturn { median: median, robustNoise: robustNoise, calibrationDrift: calibrationDrift };')(CFG);
const { median, robustNoise, calibrationDrift } = api;

// 旧的算法，用来做对照
function oldSigma(samples) {
  const base = median(samples);
  return Math.max(1, 1.4826 * median(samples.map(v => Math.abs(v - base))));
}

let seed = 20260921;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;      // 近似 N(0,~1)

function synth({ n = 540, base = 2048, noise = 2, drift = 0 }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out.push(base + noise * gauss() + drift * t);                    // drift 是整段的总漂移量
  }
  return out;
}

let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };

console.log('=== 一、没有漂移时，新旧算法应当接近 ===\n');
{
  const s = synth({ noise: 2, drift: 0 });
  const a = oldSigma(s), b = robustNoise(s);
  console.log(`  纯噪声 σ=2：旧算法 ${a.toFixed(2)}   新算法 ${b.toFixed(2)}`);
  chk(Math.abs(a - b) / a < 0.25, '没有漂移时两者接近（去漂移不会误伤真噪声）', `${a.toFixed(2)} vs ${b.toFixed(2)}`);
  chk(Math.abs(b - 2) < 0.7, '新算法给出的 σ 接近真值 2', b.toFixed(2));
}

console.log('\n=== 二、有漂移时，旧算法被带偏、新算法稳住 ===\n');
for (const drift of [4, 7, 15, 30]) {
  const s = synth({ noise: 2, drift });
  const a = oldSigma(s), b = robustNoise(s);
  const inflate = a / b;
  console.log(`  总漂移 ${String(drift).padStart(2)} counts：旧算法 ${a.toFixed(2)}（虚高 ${inflate.toFixed(1)} 倍）  新算法 ${b.toFixed(2)}`);
  chk(Math.abs(b - 2) < 0.7, `漂移 ${drift} 时新算法仍接近真值 2`, b.toFixed(2));
  if (drift >= 7) chk(inflate > 1.3, `漂移 ${drift} 时旧算法确实被带偏了（复现原缺陷）`, inflate.toFixed(2) + ' 倍');
}

console.log('\n=== 三、calibrationDrift 能量出漂移 ===\n');
for (const drift of [0, 3, 7, 20]) {
  const s = synth({ noise: 1, drift });
  const d = calibrationDrift(s);
  console.log(`  真值 ${String(drift).padStart(2)} → 量到 ${d.toFixed(1)}`);
  chk(Math.abs(d - drift) < Math.max(2, drift * 0.35), `漂移 ${drift} 量得准`, d.toFixed(1));
}
{
  // 窗口中间混进一次眨眼，不应该把漂移结论带偏（所以用中位数）
  const s = synth({ noise: 1, drift: 0 });
  for (let i = 250; i < 290; i++) s[i] -= 60;
  const d = calibrationDrift(s);
  chk(Math.abs(d) < 3, '窗口里混进一次眨眼，漂移判断不被带偏', d.toFixed(1));
}

console.log('\n=== 四、告警阈值 ===\n');
{
  const WARN = CFG.calibrationDriftWarnCounts;
  const cases = [[0, false], [4, false], [5, true], [7, true], [30, true]];
  for (const [drift, shouldWarn] of cases) {
    const d = Math.abs(calibrationDrift(synth({ noise: 1, drift })));
    const warn = d >= WARN;
    chk(warn === shouldWarn, `漂移 ${drift} → ${shouldWarn ? '应告警' : '不应告警'}（阈值 ${WARN}，量到 ${d.toFixed(1)}）`);
  }
}

console.log('\n=== 五、边界情况不会崩 ===\n');
{
  for (const [name, input] of [['空数组', []], ['只有 3 个点', [1, 2, 3]], ['全常数', Array(540).fill(2048)]]) {
    let r = null, threw = false;
    try { r = { s: robustNoise(input), d: calibrationDrift(input) }; } catch (e) { threw = true; }
    chk(!threw && Number.isFinite(r.s) && r.s >= 1 && Number.isFinite(r.d),
        `${name}：不抛异常且返回有限值`, threw ? '抛了' : `σ=${r.s.toFixed(2)} drift=${r.d.toFixed(2)}`);
  }
}

console.log('\n=== 六、实时与离线必须用同一套估计 ===\n');
{
  const liveUses = (src.match(/const sigma = robustNoise\(S\.cal\)/) || []).length;
  const offlineUses = (src.match(/const sigma = robustNoise\(cal\)/) || []).length;
  const oldLive = (src.match(/const sigma = Math\.max\(1, 1\.4826 \* mad\)/) || []).length;
  const oldOffline = (src.match(/Math\.max\(1, 1\.4826 \* mad\) \* config\.noiseMultiplier/) || []).length;
  chk(liveUses === 1, '实时判决用的是 robustNoise', String(liveUses));
  chk(offlineUses === 1, '离线判决用的也是 robustNoise', String(offlineUses));
  chk(oldLive === 0, '实时里没有残留旧算法', String(oldLive));
  chk(oldOffline === 0, '离线里没有残留旧算法', String(oldOffline));
}

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
