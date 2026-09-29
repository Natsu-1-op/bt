const { readPageSource, extractFunction } = require('./helpers/source');
// 导出功能的测试。用法（包根目录）: node tests/test_export.js
//
// 覆盖两件出过 / 容易出问题的事：
//   1) 可导性校验（阈值过严曾经导致加跳过之后录的每一条都导不出去）
//   2) 「导出全部」是手写 JSON 拼装 —— 拼错一个逗号整个文件就废了
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

function grab(name) { return extractFunction(src, name); }
function grabAsync(name) { return extractFunction(src, name); }

const CFG = { sampleRateHz: 200, calibrationMs: 3000, calibrationSkipMs: 300 };
const pure = new Function('CFG', grab('minCalibrationSamples') + '\n' + grab('exportRejectReason') +
  '\nreturn { minCalibrationSamples, exportRejectReason };')(CFG);

let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };

// 造一条"正常录完"的会话
const rec = (over = {}) => ({
  id: 'S1', schema: 'blink-collector/v1', status: 'stopped',
  created_utc_ms: 1700000000000,
  participant_id: 'P001',
  config: { calibrationMs: 3000, calibrationSkipMs: 300, calibrationSkipMs: 300 },
  quality: { received: 12000, calibration_samples: 541, calibration_valid: true },
  ...over
});

console.log('=== 一、正常记录必须能导出 ===\n');
{
  const r = pure.exportRejectReason(rec());
  chk(r === null, '新记录（跳过 300ms，541 个标定样本）', r || '可导出');
}
{
  const r = pure.exportRejectReason(rec({ config: { calibrationMs: 3000 }, quality: { received: 12000, calibration_samples: 601, calibration_valid: true } }));
  chk(r === null, '旧记录（无 skip 字段，601 个样本）', r || '可导出');
}
{
  // 这是关键一条：记录里写了 skip=500，就该按 500 算下限（501 个样本要能过）
  const r = pure.exportRejectReason(rec({ config: { calibrationMs: 3000, calibrationSkipMs: 500 }, quality: { received: 12000, calibration_samples: 501, calibration_valid: true } }));
  chk(r === null, '用 skip=500 录的记录（501 个样本）—— 必须按会话自己的 skip 算下限',
      r || '可导出');
}
{
  const r = pure.exportRejectReason(rec({ config: { calibrationMs: 3000 }, quality: { received: 12000, calibration_samples: 599, calibration_valid: true } }));
  chk(r === null, '夹缝记录（无 skip 字段，599 个样本）—— 退回当前 CFG 的宽松下限', r || '可导出');
}

console.log('\n=== 二、真正不完整的记录必须挡住 ===\n');
const rejects = [
  ['null', null],
  ['没有 id', { status: 'stopped' }],
  ['还在录制中', rec({ status: 'recording' })],
  ['保存出过错', rec({ storage_error: 'quota' })],
  ['准备阶段无效(status)', rec({ status: 'calibration_invalid' })],
  ['准备阶段无效(quality)', rec({ quality: { received: 100, calibration_samples: 541, calibration_valid: false } })],
  ['没记样本数', rec({ quality: { received: 100, calibration_valid: true } })],
  ['样本太少 400', rec({ quality: { received: 100, calibration_samples: 400, calibration_valid: true } })],
  ['样本太少 0', rec({ quality: { received: 0, calibration_samples: 0, calibration_valid: true } })],
];
for (const [name, r] of rejects) {
  const reason = pure.exportRejectReason(r);
  chk(reason !== null, `拒绝：${name}`, reason || '竟然放行了');
}

console.log('\n=== 三、下限本身 ===\n');
chk(pure.minCalibrationSamples() === 513, 'minCalibrationSamples() = 513（3000-300 的 95%）', String(pure.minCalibrationSamples()));
chk(pure.minCalibrationSamples({ calibrationSkipMs: 0 }) === 570, 'skip=0 时 = 570', String(pure.minCalibrationSamples({ calibrationSkipMs: 0 })));
chk(pure.minCalibrationSamples({ calibrationSkipMs: 500 }) === 475, 'skip=500 时 = 475', String(pure.minCalibrationSamples({ calibrationSkipMs: 500 })));
chk(pure.minCalibrationSamples(undefined) === 513, '不传参数时退回 CFG 的值', String(pure.minCalibrationSamples(undefined)));

// ---------- 四、「导出全部」的 JSON 拼装必须合法 ----------
console.log('\n=== 四、导出全部的 JSON 拼装 ===\n');

function makeEnv({ sessions, failIds = [] }) {
  const saved = [], alerts = [];
  const S = { busy: false, phase: 'STOPPED', writeChain: Promise.resolve() };
  const buildBundle = async r => {
    if (failIds.includes(r.id)) throw new Error('数据不完整（测试桩）');
    return { schema: 'blink-export/v1', metadata: { id: r.id }, events: [], sample_chunks: [] };
  };
  const openDb = async () => ({
    transaction: () => ({ objectStore: () => ({
      getAll: () => { const req = {}; setTimeout(() => { req.result = sessions; req.onsuccess && req.onsuccess(); }, 0); return req; },
    }) }),
  });
  const fn = new Function('S', 'ui', 'refreshButtons', 'openDb', 'buildBundle', 'saveBlob', 'iso', 'confirm', 'alert',
    grabAsync('exportAllSessions') + '\nreturn exportAllSessions;');
  return {
    run: fn(S, {}, () => {}, openDb, buildBundle,
      (name, type, parts) => saved.push({ name, type, parts }),
      ms => new Date(ms).toISOString(),
      () => true,
      m => alerts.push(m)),
    saved, alerts, S,
  };
}

(async () => {
  {
    const e = makeEnv({ sessions: [rec({ id: 'A' }), rec({ id: 'B' }), rec({ id: 'C' })] });
    await e.run();
    chk(e.saved.length === 1, '三条记录 → 生成一个文件');
    if (e.saved.length) {
      const text = e.saved[0].parts.join('');
      let parsed = null, err = null;
      try { parsed = JSON.parse(text); } catch (x) { err = x.message; }
      chk(parsed !== null, '拼出来的 JSON 能被 JSON.parse', err || 'ok');
      if (parsed) {
        chk(parsed.schema === 'blink-export-all/v1', 'schema 正确');
        chk(Array.isArray(parsed.sessions) && parsed.sessions.length === 3, 'sessions 有 3 条', String(parsed.sessions && parsed.sessions.length));
        chk(parsed.session_count === 3, 'session_count = 3');
        chk(Array.isArray(parsed.skipped) && parsed.skipped.length === 0, 'skipped 为空数组');
        chk(parsed.sessions.map(s => s.metadata.id).join(',') === 'A,B,C', '顺序按时间升序');
      }
      chk(/^blink-all-.*\.json$/.test(e.saved[0].name), '文件名形如 blink-all-<时间>.json', e.saved[0].name);
    }
  }
  console.log('');
  {
    const e = makeEnv({ sessions: [rec({ id: 'A' }), rec({ id: 'BROKEN' }), rec({ id: 'C' })], failIds: ['BROKEN'] });
    await e.run();
    const text = e.saved[0] ? e.saved[0].parts.join('') : '';
    const parsed = text ? JSON.parse(text) : null;
    chk(parsed && parsed.sessions.length === 2, '坏记录被跳过，好记录照常导出', String(parsed && parsed.sessions.length));
    chk(parsed && parsed.skipped.length === 1 && parsed.skipped[0].id === 'BROKEN', 'skipped 里记下了坏记录的 id');
    chk(parsed && parsed.session_count === 2, 'session_count 只数成功的');
    chk(e.alerts.some(a => a.includes('1 条跳过')), '弹窗告诉用户跳过了几条');
  }
  console.log('');
  {
    const e = makeEnv({ sessions: [rec({ id: 'X' })], failIds: ['X'] });
    let threw = null;
    try { await e.run(); } catch (err) { threw = err.message; }
    chk(threw && threw.includes('没有一条能导出'), '全部失败时明确报错，不产出空文件', threw || '竟然没报错');
    chk(e.saved.length === 0, '全部失败时不产生文件');
  }
  console.log('');
  {
    const e = makeEnv({ sessions: [] });
    await e.run();
    chk(e.saved.length === 0 && e.alerts.some(a => a.includes('还没有保存')), '本机没有记录时提示且不产生文件');
  }

  console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
  process.exit(bad ? 1 : 0);
})();
