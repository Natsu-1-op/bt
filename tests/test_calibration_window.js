const { readPageSource, extractFunction } = require('./helpers/source');
// 标定窗口一致性测试。用法（包根目录）: node tests/test_calibration_window.js
//
// 起因：加了 calibrationSkipMs（标定开头跳过蓝牙尖峰）之后，
//   · exportBundle 仍按满 3000ms 要求 ≥600 个标定样本，而实际只收到 540
//     → 那次改动之后录的每一条都被判"准备阶段无效"，全部导不出去
//   · makeOfflineDetector 的标定窗口没有跳过 → 同一份数据"实时"和"回看"结果不同
// 这个测试同时盯住这两件事。
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

function grab(name) { return extractFunction(src, name); }
const liveLine = src.match(/if \(t - S\.calStartMs >= CFG\.calibrationSkipMs\) S\.cal\.push\(filt\);/);
const offBlock = src.match(/const skipMs = Number\(config\.calibrationSkipMs\) \|\| 0;\n\s*if \(t - calStart >= skipMs\) cal\.push\(filt\);/);
if (!liveLine || !offBlock) throw new Error('没能同时抽到实时与离线的取样条件');
console.log('抽取到的真实取样条件:');
console.log('  实时: ' + liveLine[0].trim());
console.log('  离线: ' + offBlock[0].split('\n').map(s => s.trim()).join(' | '));
console.log('');

const CFG = { sampleRateHz: 200, calibrationMs: 3000, calibrationSkipMs: 300 };
const minCal = new Function('CFG', grab('minCalibrationSamples') + '\nreturn minCalibrationSamples;')(CFG);
const minCalSamples = minCal();

// ---- 实时路径：直接用 onSample 里那行真实代码 ----
// ⚠️ 那行读的是全局 CFG.calibrationSkipMs，所以要改就得改 CFG 本身 ——
//    改副本的话三种跳过值会算成同一个数（我第一版就踩了这个坑）。
function liveCount(skipMs) {
  const saved = CFG.calibrationSkipMs;
  CFG.calibrationSkipMs = skipMs;
  const S = { cal: [], calStartMs: null };
  const filt = 2048;
  for (let t = 0; t < 10000; t += 5) {
    if (S.calStartMs === null) S.calStartMs = t;
    eval(liveLine[0]);
    if (t - S.calStartMs >= CFG.calibrationMs) break;
  }
  CFG.calibrationSkipMs = saved;
  return S.cal.length;
}

// ---- 离线路径：直接用 makeOfflineDetector 里那两行真实代码 ----
function offlineCount(skipMs) {
  const config = { ...CFG, calibrationSkipMs: skipMs };
  const cal = [];
  const calStart = 0;
  const filt = 2048;
  for (let t = 0; t < 10000; t += 5) {
    eval(offBlock[0]);
    if (t - calStart >= config.calibrationMs) break;
  }
  return cal.length;
}

let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };

console.log('=== 一、实时与离线必须收到一样多的标定样本 ===\n');
for (const skip of [0, 300, 500]) {
  const a = liveCount(skip), b = offlineCount(skip);
  chk(a === b && a > 0, `跳过 ${skip}ms：实时 ${a} 个 / 离线 ${b} 个 一致`, a === b ? '' : '两边不一致！');
}

console.log('\n=== 二、导出下限必须跟得上实际样本数 ===\n');
const liveNew = liveCount(300), liveOld = liveCount(0);
console.log(`  新记录（跳过 300ms）实际收到 ${liveNew} 个标定样本`);
console.log(`  旧记录（不跳过）  实际收到 ${liveOld} 个标定样本`);
console.log(`  minCalibrationSamples() = ${minCalSamples}`);
chk(liveNew >= minCalSamples, '新记录能通过导出校验（这就是之前全部导不出的原因）', `${liveNew} >= ${minCalSamples}`);
chk(liveOld >= minCalSamples, '旧记录也能通过导出校验', `${liveOld} >= ${minCalSamples}`);
chk(minCalSamples < Math.ceil(CFG.sampleRateHz * CFG.calibrationMs / 1000),
    '下限已经不再按满 3000ms 算（旧值 600 就是 bug）',
    `${minCalSamples} < ${Math.ceil(CFG.sampleRateHz * CFG.calibrationMs / 1000)}`);
chk(liveNew !== Math.ceil(CFG.sampleRateHz * CFG.calibrationMs / 1000),
    '实际样本数确实不是 600（复现原 bug 的前提）', `实际 ${liveNew}`);

console.log('\n=== 三、下限仍然要挡得住真正没标定的记录 ===\n');
const tooFew = [0, 1, 50, 200, 400];
for (const n of tooFew) {
  chk(n < minCalSamples, `只有 ${n} 个标定样本 → 拒绝导出（够不着下限 ${minCalSamples}）`);
}

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
