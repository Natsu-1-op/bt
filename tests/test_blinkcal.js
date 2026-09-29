const { readPageSource, extractFunction } = require('./helpers/source');
// 现场眨眼标定（方案 C）的测试。用法（包根目录）: node tests/test_blinkcal.js
//
// 这里锁的是三件容易做错的事：
//   1. 最终阈值不能被 minDropCounts 卡住 —— 卡住就永远降不下去，功能等于没做
//   2. 临时阈值必须真的比正式阈值灵敏 —— 否则浅眨眼量不到，标定白做
//   3. 候选里混进一个很浅的伪迹时，阈值不能被它拉崩
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

function grab(name) { return extractFunction(src, name); }

const CFG = {
  adcMax: 4095, sampleRateHz: 200, calibrationMs: 3000, calibrationSkipMs: 300,
  noiseMultiplier: 4, minDropCounts: 12, releaseRatio: 0.45, refractoryMs: 300,
  blinkCalRatio: 0.6, blinkCalTarget: 5, blinkCalMinAccepted: 3, blinkCalMaxMs: 20000,
  blinkCalMinWidthMs: 100, blinkCalProvisionalSigma: 2.5, blinkCalProvisionalFloor: 6,
  blinkCalNoiseGuardSigma: 4,
};

function makeEnv({ noise = 1, depths = [], ratio = 0.6, baseline = 2048 }) {
  const events = [];
  const S = { phase: 'CAL', noise, baseline, dropCounts: 0, thDown: 0, thUp: 0,
              inBlink: false, refractoryUntil: 0, lastT: 1000, blinkCal: { depths: depths.slice(), startMs: 0 },
              session: { config: { ...CFG, blinkCalRatio: ratio } } };
  const ui = { help: { textContent: '', innerHTML: '' } };
  const state = { set: null };
  const api = new Function('S', 'CFG', 'ui', 'setState', 'addEvent', 'sampleUtc', 'persistSession',
    'refreshButtons', 'currentConfig', 'updateDebugControls',
    grab('startBlinkCalibration') + '\n' + grab('updateBlinkCalPrompt') + '\n' + grab('finishBlinkCal') +
    '\nreturn { startBlinkCalibration, finishBlinkCal, updateBlinkCalPrompt };');
  const inst = api(S, CFG, ui, n => { state.set = n; }, (t, u, x, extra) => events.push({ t, extra }),
    () => 0, () => {}, () => {}, () => ({ ...CFG, blinkCalRatio: ratio }), () => {});
  return { ...inst, S, ui, events, state };
}

let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };

console.log('=== 一、最终阈值：深度法 vs 噪声下限 ===\n');
{
  const e = makeEnv({ noise: 1, depths: [10, 12, 14, 16, 20] });
  e.finishBlinkCal('target_reached');
  console.log(`  σ=1.00, 深度 [10,12,14,16,20] → 阈值 ${e.S.dropCounts}`);
  console.log(`  ${e.S.session.blink_calibration.note}`);
  chk(e.S.dropCounts < CFG.minDropCounts, '阈值能降到 minDropCounts(12) 以下（这是功能存在的理由）', String(e.S.dropCounts));
  chk(Math.abs(e.S.dropCounts - 12 * 0.6) < 0.01, '取第 20 百分位(12) × 0.6 = 7.2', String(e.S.dropCounts));
}
{
  const e = makeEnv({ noise: 3.89, depths: [10, 12, 14, 16, 20] });
  e.finishBlinkCal('target_reached');
  console.log(`\n  σ=3.89, 同样深度 → 阈值 ${e.S.dropCounts.toFixed(2)}`);
  chk(Math.abs(e.S.dropCounts - 3.89 * 4) < 0.01, '噪声大时由 4σ 下限兜住（=15.56）', e.S.dropCounts.toFixed(2));
}

console.log('\n=== 二、抗单个离群点（很浅的伪迹）===\n');
{
  const e = makeEnv({ noise: 1, depths: [4, 20, 22, 24, 26] });
  e.finishBlinkCal();
  console.log(`  深度 [4,20,22,24,26]（4 是伪迹）→ 阈值 ${e.S.dropCounts}`);
  chk(Math.abs(e.S.dropCounts - 20 * 0.6) < 0.01, '第 20 百分位忽略最小的那个，取 20×0.6=12', String(e.S.dropCounts));
  chk(e.S.dropCounts > 4 * 0.6, '没有被伪迹把阈值拉到 2.4（那会满屏误检）');
}

console.log('\n=== 三、眨得不够时自动退回噪声法 ===\n');
{
  const e = makeEnv({ noise: 1, depths: [10, 12] });
  e.finishBlinkCal('timeout');
  console.log(`  只记录到 2 次（需要 3 次）→ 阈值 ${e.S.dropCounts}`);
  chk(e.S.dropCounts === CFG.minDropCounts, '退回噪声法：max(下限12, σ×等级4)=12', String(e.S.dropCounts));
  chk(e.S.session.blink_calibration.note.includes('退回'), '记录里写明是退回的');
  chk(e.S.phase === 'RUN', '无论如何都要进 RUN，不能卡住');
}
{
  const e = makeEnv({ noise: 1, depths: [] });
  e.finishBlinkCal('timeout');
  chk(e.S.dropCounts === CFG.minDropCounts && e.S.phase === 'RUN', '一次都没眨也要正常进 RUN', String(e.S.dropCounts));
}

console.log('\n=== 四、临时阈值必须真的更灵敏 ===\n');
{
  const e = makeEnv({ noise: 1, depths: [] });
  e.S.session.config.minDropCounts = 5;
  e.finishBlinkCal('timeout');
  chk(e.S.dropCounts === 5, '回退使用本次配置下限5，不得跳回代码默认12');
}
{
  const e = makeEnv({ noise: 1 });
  e.startBlinkCalibration();
  const formal = Math.max(CFG.minDropCounts, 1 * CFG.noiseMultiplier);
  console.log(`  σ=1.00：临时阈值 ${e.S.dropCounts}  正式噪声法会用的 ${formal}`);
  chk(e.S.phase === 'BLINKCAL', '进入 BLINKCAL 阶段');
  chk(e.S.dropCounts === 6, '临时阈值 = max(6, 1×2.5) = 6（刻度很小才量得到浅眨眼）', String(e.S.dropCounts));
  chk(e.S.dropCounts < formal, '临时阈值确实比正式阈值灵敏', `${e.S.dropCounts} < ${formal}`);
}
{
  const e = makeEnv({ noise: 3.89 });
  e.startBlinkCalibration();
  console.log(`  σ=3.89：临时阈值 ${e.S.dropCounts.toFixed(2)}`);
  chk(Math.abs(e.S.dropCounts - 9.725) < 0.01, '噪声大时临时阈值跟着抬到 2.5σ=9.73', e.S.dropCounts.toFixed(2));
}

console.log('\n=== 五、阈值一定 >= 4（噪声兜底）===\n');
{
  // S.noise 有下限 1，所以 4σ >= 4。就算标定到极浅的眨眼也不会低到离谱。
  for (const nd of [[6, 6, 6], [5, 5, 5, 5, 5]]) {
    const e = makeEnv({ noise: 1, depths: nd });
    e.finishBlinkCal();
    chk(e.S.dropCounts >= 4, `深度 ${JSON.stringify(nd)} → 阈值 ${e.S.dropCounts}，不低于 4`, String(e.S.dropCounts));
  }
}

console.log('\n=== 六、结果写进会话记录（可追溯）===\n');
{
  const e = makeEnv({ noise: 1, depths: [10, 12, 14, 16, 20] });
  e.finishBlinkCal('target_reached');
  const bc = e.S.session.blink_calibration;
  chk(!!bc && bc.enabled === true && bc.accepted === 5 && bc.reason === 'target_reached', 'blink_calibration 记录了结果');
  chk(Array.isArray(bc.depths) && bc.depths.length === 5, '原始深度都留着（事后能复核）');
  chk(typeof bc.threshold === 'number' && typeof bc.noise_sigma === 'number', '阈值和当时的噪声都记了');
  chk(e.events.some(x => x.extra && x.extra.threshold), '写了一条 blink_calibration_done 事件');
}

{
  const e=makeEnv({noise:3,depths:[2,2,2,2,2]});
  e.S.session.config.noiseMultiplier=0;
  e.S.session.config.minDropCounts=0;
  e.finishBlinkCal('target_reached');
  chk(e.S.dropCounts===1.2,'方案 C 正式阈值不再被固定 4σ 卡住');
  e.startBlinkCalibration();
  chk(e.S.dropCounts===0,'方案 C 临时阈值跟随现场零下限/零倍数，不固定 6');
}
console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
