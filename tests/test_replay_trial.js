const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page');

// 重放试调：改了阈值，波形上的黄线（事件标记）必须跟着变。
//
// 这条测试盯的是用户实际报的现象：「改变（试）调阈值后波形的黄线不改变」。
// 原有的 test_import_replay 测的是数据（trial.drop_counts / 导出内容），
// 但它的合成记录只有 ±1 抖动、压根没有眨眼，所以**黄线画出来都是 0 条** ——
// 阈值怎么改都是 0，症状再明显也测不出来。这里用带真眨眼的记录，并且直接数画布上
// 真正描出来的黄线，把「用户看到的东西」本身作为断言对象。
//
// 同时覆盖一个静默失败：控制台会话 30 分钟过期后，applyReplayTrial 以前直接 return，
// 面板毫无反应 —— 表现和「功能坏了」一模一样。

const yellow = [];   // 每次黄色描边的折线点集
const strokes = [];
function instrument(w) {
  w.HTMLCanvasElement.prototype.getContext = () => {
    let style = null, cur = null;
    return new Proxy({}, {
      get: (t, k) => {
        if (k === 'measureText') return () => ({ width: 16 });
        if (k === 'getImageData') return (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
        if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
        // draw() 的第一句就是 clearRect —— 拿它当帧边界，只保留**最后一帧**的黄线。
        // 否则 tickAsync 里跑了 2 帧，会把两帧的线加在一起，断言变得看运气。
        if (k === 'clearRect') return () => { yellow.length = 0; cur = null; };
        if (k === 'beginPath') return () => { cur = []; };
        if (k === 'moveTo') return (x, y) => { if (cur) cur.push([x, y]); };
        if (k === 'lineTo') return (x, y) => { if (cur) cur.push([x, y]); };
        if (k === 'stroke') return () => { if (style === '#f4bf4f' && cur) { yellow.push(cur.slice()); strokes.push(cur.length); } };
        return () => {};
      },
      set: (t, k, v) => { if (k === 'strokeStyle') style = v; t[k] = v; return true; },
    });
  };
}

(async () => {
  const e = loadPage('test.html', { session: true, setup: instrument });
  const w = e.w, a = e.app;
  const $ = id => w.document.getElementById(id);
  try {
    a.applyConsoleConfig({ minDropCounts: 0, manualDropCounts: 12, manualThresholdEnabled: true, noiseMultiplier: 0 });
    a.S.connected = true;
    await a.beginFormalSession();

    // 20 秒 / 200Hz；每 1.5 秒一次 150ms 宽的眨眼，深度【深浅交替】（40 / 8）——
    // 必须深浅不一，否则原始与试调会检出同样多的事件，阈值怎么改都看不出差别。
    const N = 4000, base = 2048;
    for (let i = 0; i < N; i++) {
      const t = 1000 + i * 5, ph = t % 1500;
      let v = base + ((i % 3) - 1);
      if (ph < 150) {
        const amp = (Math.floor(t / 1500) % 2) ? 8 : 40;
        v -= amp * Math.sin(Math.PI * ph / 150);
      }
      a.onSample(t, Math.round(v));
    }
    await a.stopSession('user');

    a.ui.sessionList.value = a.S.session.id;
    await a.loadSelectedSession();
    const snapshot = JSON.stringify(a.S.session);
    await a.startReplay();
    assert(a.S.replay.events.length > 0, '合成记录里应该有真眨眼');

    const frame = async (label) => {           // 跑一帧，数这一帧画了多少条黄线
      yellow.length = 0; strokes.length = 0;
      await e.clock.tickAsync(30);
      return yellow.length;
    };
    const applyTrial = async (drop) => {
      $( 'trialDrop').value = String(drop);
      const p = a.applyReplayTrial();
      await e.clock.tickAsync(200);            // 内部靠 setTimeout(0) 分批让出主线程
      await p;
      await a.seekReplay(a.S.replay.end);      // 停在末尾，让 8 秒窗口覆盖最后一截
    };

    await a.seekReplay(a.S.replay.end);
    const original = await frame('原始');
    assert(original > 0, `原始记录应画出黄线，实际 ${original} 条`);

    // 眨眼深 40：阈值抬到 80 应该一个都不剩
    await applyTrial(80);
    assert.equal(a.S.replay.trial.drop_counts, 80);
    assert.equal(a.S.replay.trial.events.length, 0, '阈值 80 下不该还有事件');
    assert.equal(await frame('阈值80'), 0, '阈值 80 时波形上不该再有黄线');

    // 阈值压到 2：连 8 深的浅眨眼也该检出来，黄线必须比原始多
    await applyTrial(2);
    const low = await frame('阈值2');
    assert(low > original, `阈值 2 的黄线应多于原始（${low} vs ${original}）`);
    assert(a.S.replay.trial.events.length > a.S.replay.events.length, '浅眨眼应被额外检出');
    assert.equal(a.S.replay.trial.config.refractoryMs, a.S.session.config.refractoryMs);

    // 原始数据一个字节都不能变
    assert.equal(JSON.stringify(a.S.session), snapshot, '试调不得改动原始记录');

    // 恢复按钮：黄线回到原始口径
    $('trialReset').click();
    assert.equal(a.S.replay.trial, null);
    await a.seekReplay(a.S.replay.end);
    assert.equal(await frame('恢复后'), original, '恢复后应回到原始黄线数');

    // —— 登录过期不能静默什么都不做 ——
    w.sessionStorage.setItem('blink-console-auth-v1', JSON.stringify({ expiresAt: 0 }));
    $('trialDrop').value = '9';
    const expiredCall = a.applyReplayTrial();
    await e.clock.tickAsync(200);
    await expiredCall;
    assert.match($('trialStatus').textContent, /登录已过期/, '过期时要说明原因，而不是静默无反应');
    assert.equal(a.S.replay.trial, null, '过期时不得改动试调结果');

    // 重新登录后恢复正常
    w.sessionStorage.setItem('blink-console-auth-v1', JSON.stringify({ expiresAt: w.Date.now() + 1800000 }));
    await applyTrial(2);
    assert.equal(a.S.replay.trial.drop_counts, 2, '重新登录后应能继续试调');

    a.stopReplay();
    assert.equal(e.errors.length, 0, e.errors.join('\n'));
  } finally { e.close(); }
  console.log('PASS replay trial threshold repaints waveform markers; expired session fails loudly; original record untouched');
})().catch(err => { console.error(err); process.exitCode = 1; });
