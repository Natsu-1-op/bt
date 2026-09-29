const { readPageSource, extractFunction } = require('./helpers/source');
// 调试台配置回填的一致性测试。
//
// 背景（2026-09-23 实测事故）：
//   调试台 consolePayload() 往云端写 7 个参数，但 applyConsoleConfig() 只回填 4 个
//   （漏了 minDropCounts / blinkCalEnabled / blinkCalRatio）。
//   结果：在调试台改阈值 → 保存到云端 → 刷新页面 → 输入框退回 HTML 默认值 12，
//   看起来就是「输入了阈值但无法更新」。
//
// 18 个老测试全绿却没抓到它，原因有两个：
//   ① 没有一条测试碰 test.html 的配置路径（只有 test_login / test_page_load 碰 test.html）
//   ② 唯一相关的 test_cloudsync.js 只抽 index.html，而且只断言 4 个字段
//
// 这个测试从**真实的 test.html / index.html** 里抽出函数体来跑，不是复制品。
// 抽取失败必须 throw（见 06-踩过的坑 坑 5），绝不能静默跳过。
//
// 用法（仓库根目录）: node tests/test_console_config.js
// 想拿旧页面验证它会红: BLINK_PAGE_DIR=<某目录含旧 test.html> node tests/test_console_config.js
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PAGE_DIR = process.env.BLINK_PAGE_DIR || path.join(__dirname, '..');
const read = f => readPageSource(path.join(PAGE_DIR, f));
const testSrc = read('test.html');
const idxSrc = read('index.html');

function extract(src, name) { return extractFunction(src, name); }

// ---------------------------------------------------------------- 静态：字段集合
// consolePayload() 里写成 `<key>: c.<something>` 的，就是要存进云端的配置字段
const payloadBlock = testSrc.slice(testSrc.indexOf('function consolePayload()'));
const payloadKeys = new Set([...payloadBlock.matchAll(/(\w+):\s*c\./g)].map(m => m[1]));
// 只看真正的配置参数（oledText/oledBitmap/updatedAt/updatedBy 不是参数）
const CONFIG_KEYS = ['noiseMultiplier', 'refractoryMs', 'manualThresholdEnabled', 'manualDropCounts',
  'minDropCounts', 'blinkCalEnabled', 'blinkCalRatio'];
const written = CONFIG_KEYS.filter(k => payloadKeys.has(k));

const appliedIn = src => {
  const block = extract(src, 'applyConsoleConfig');
  return new Set([...block.matchAll(/cfg\.(\w+)/g)].map(m => m[1]));
};
const appliedTest = appliedIn(testSrc);
const appliedIndex = appliedIn(idxSrc);

// ---------------------------------------------------------------- 动态：真的灌一遍
const INPUT_IDS = ['fMult', 'fRefr', 'manualDrop', 'manualThresholdEnabled',
  'fMinDrop', 'fBlinkCal', 'fBlinkCalRatio', 'debugReadout'];
const makeUI = () => {
  const o = {};
  for (const id of INPUT_IDS) o[id] = { id, value: '', checked: false, disabled: false, textContent: '' };
  return o;
};
const CFG = { minDropCounts: 12, noiseMultiplier: 4, refractoryMs: 300, blinkCalRatio: 0.6 };

const CLOUD = { noiseMultiplier: 3, refractoryMs: 250, manualThresholdEnabled: false,
  manualDropCounts: 45, minDropCounts: 8, blinkCalEnabled: true, blinkCalRatio: 0.7 };

const ui = makeUI();
// applyConsoleConfig() 会顺带清掉「保存期间参数又改了」的标记（S.consoleConfigDirty），
// 所以沙箱里必须给一个 S —— 少了它整个测试会以 ReferenceError 挂掉（c12de7a 就是这样变红的）。
const S = { consoleConfigDirty: true };
const applyConsoleConfig = new Function('ui', 'CFG', 'updateDebugControls', 'S', 'isValidDisplayHex', 'cacheDisplay',
  extract(testSrc, 'applyConsoleConfig') + '; return applyConsoleConfig;')(ui, CFG, () => {}, S, () => false, () => {});
applyConsoleConfig(CLOUD);

// ---------------------------------------------------------------- 锁定名单
const lockBlock = extract(testSrc, 'lockSessionInputs');
const locked = new Set([...lockBlock.matchAll(/ui\.(\w+)/g)].map(m => m[1]));

// ---------------------------------------------------------------- 判定
let bad = 0;
const chk = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) bad++; };

console.log(`页面目录：${PAGE_DIR}\n`);
console.log('一、写入云端的字段，必须都能回填（test.html）');
console.log(`  写入：${JSON.stringify(written)}`);
for (const k of written) {
  chk(appliedTest.has(k), `applyConsoleConfig() 回填了 ${k}`);
}

console.log('\n二、index.html 的 applyConsoleConfig() 也要覆盖同一组（两页不能分叉）');
for (const k of written) {
  chk(appliedIndex.has(k), `index.html 回填了 ${k}`);
}

console.log('\n三、真的把云端配置灌一遍，输入框必须拿到那些值');
chk(ui.fMult.value === '3', `抗干扰等级 = 3（实际 ${ui.fMult.value}）`);
chk(ui.fRefr.value === '250', `不应期 = 250（实际 ${ui.fRefr.value}）`);
chk(ui.manualThresholdEnabled.checked === false, '手动模式 = 关');
chk(ui.manualDrop.value === '45', `手动阈值 = 45（实际 ${ui.manualDrop.value}）`);
chk(ui.fMinDrop.value === '8', `下限 minDropCounts = 8（实际 ${ui.fMinDrop.value}）← 本次事故字段`);
chk(ui.fBlinkCal.checked === true, `方案 C = 开（实际 ${ui.fBlinkCal.checked}）← 本次事故字段`);
chk(ui.fBlinkCalRatio.value === '0.7', `方案 C 比例 = 0.7（实际 ${ui.fBlinkCalRatio.value}）← 本次事故字段`);
chk(S.consoleConfigDirty === false, '回填后清掉了「保存期间参数又改了」标记');

console.log('\n四、越界值必须被夹住（不能让阈值变成 NaN 或负数）');
const ui2 = makeUI();
const S2 = { consoleConfigDirty: true };
const apply2 = new Function('ui', 'CFG', 'updateDebugControls', 'S', 'isValidDisplayHex', 'cacheDisplay',
  extract(testSrc, 'applyConsoleConfig') + '; return applyConsoleConfig;')(ui2, CFG, () => {}, S2, () => false, () => {});
apply2({ noiseMultiplier: 99, refractoryMs: -5, manualDropCounts: 999999,
  minDropCounts: -3, blinkCalRatio: 5 });
chk(ui2.fMult.value === '12', `等级 99 → 12（实际 ${ui2.fMult.value}）`);
chk(ui2.fRefr.value === '0', `不应期 -5 → 0（实际 ${ui2.fRefr.value}）`);
chk(ui2.manualDrop.value === '2000', `手动阈值 999999 → 2000（实际 ${ui2.manualDrop.value}）`);
chk(ui2.fMinDrop.value === '0', `下限 -3 → 0（实际 ${ui2.fMinDrop.value}）`);
chk(ui2.fBlinkCalRatio.value === '1', `方案C 比例 5 → 1（实际 ${ui2.fBlinkCalRatio.value}）`);

console.log('\n五、会话期间必须锁住阈值类输入（配置在开始时快照，改了也不会生效）');
for (const id of ['fMinDrop', 'fBlinkCal', 'fBlinkCalRatio']) {
  chk(locked.has(id), `lockSessionInputs 锁住了 ${id}`);
}

console.log('\n六、面板必须说明「现在是谁决定阈值」（取大值 ⇒ 调错那个就白调，已白调三次）');
const ui3 = makeUI();
ui3.manualThresholdEnabled.checked = true;   // 手动模式
ui3.manualDrop.value = '12';
ui3.fMinDrop.value = '8';                    // 用户输入 8
// thresholdDeciderText() 依赖 boundedInputNumber()，而它又依赖 clamp()。
// 抽取式沙箱必须把这两个也带上，否则会以 ReferenceError 挂掉而不是给出判定。
const clampFn = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
let readout = '';
const update = new Function('ui', 'CFG', 'clamp', 'S', 'currentConfig',
  extract(testSrc, 'boundedInputNumber') + ';\n'
  + extract(testSrc, 'thresholdDeciderText') + ';\nreturn thresholdDeciderText;')(ui3, CFG, clampFn, {phase:'IDLE'}, () => ({blinkCalEnabled:false}));
readout = update();
console.log(`  readout = ${readout}`);
chk(/12/.test(readout), '面板说出了当前生效的阈值（max(8,12)=12）');
chk(/手动阈值/.test(readout) && /不会/.test(readout), '面板点名了是【手动阈值】在起作用，且说明改下限没用');

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
