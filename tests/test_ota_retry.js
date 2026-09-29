const { readPageSource, extractFunction } = require('./helpers/source');
// OTA 上传流程的重试逻辑测试。
// 用法（包根目录）: node tests/test_ota_retry.js
//
// 起因：重试循环里 `await sendOtaCommand()` 一旦抛异常（丢应答超时最常见）
// 会直接冒泡出去把整个升级中止，3 次重试形同虚设。
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

const runOtaSrc = extractFunction(src, 'runOta');

const OTA_PACKET_BYTES = 32;
const IMAGE = new Uint8Array(80);            // 80 字节 → 3 个包：32 / 32 / 16
for (let k = 0; k < IMAGE.length; k++) IMAGE[k] = k & 0xff;

// 每个用例：定义"第几次调用会怎样"，然后检查重试行为
function makeEnv(behaviour) {
  const sent = [];
  const S = { connected: true, writeFn: () => {}, phase: 'STOPPED', busy: false,
              ota: { running: false, waiter: null }, bleWriteChain: Promise.resolve() };
  const ui = { otaFile: { files: [{ text: async () => 'x' }] }, otaStatus: { textContent: '' } };
  const counters = new Map();
  const sendOtaCommand = async cmd => {
    sent.push(cmd);
    const key = cmd.split(',')[0] + ':' + (cmd.split(',')[1] || '');
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    const r = behaviour(cmd, n, sent);
    if (r === 'timeout') throw new Error('等待设备 OTA 应答超时');
    // 忠实模拟真实的 consumeOtaReply：设备回 OTA,ERR,xxx 时它是 reject 而不是 resolve。
    // 不这么做的话，"BEGIN 被拒"这条会测成笼统的"设备未确认"，测不到真正的原因。
    if (Array.isArray(r) && r[1] === 'ERR') throw new Error('设备拒绝 OTA：' + r.slice(2).join(','));
    return r;
  };
  const fn = new Function('S', 'ui', 'refreshButtons', 'parseIntelHex', 'sendOtaCommand',
    'bytesToHex', 'crc16Ccitt', 'OTA_PACKET_BYTES', 'setTimeout',
    runOtaSrc + '\nreturn runOta;');
  return {
    sent, S,
    // ⚠️ fn(...) 只是【返回】runOta 这个函数，末尾那个 () 才是真的调用它。
    //    少了它会变成"await 一个函数"，立刻 resolve，runOta 根本没跑 ——
    //    症状是 sent 为空但也不报错。
    run: () => fn(S, ui, () => {},
      () => ({ image: IMAGE, size: IMAGE.length, crc32: 0x1234 }),
      sendOtaCommand,
      b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''),
      () => 0, OTA_PACKET_BYTES, (f) => f())(),
  };
}

let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };
const countOf = (sent, prefix) => sent.filter(c => c.startsWith(prefix)).length;

(async () => {
  console.log('=== 一、正常路径 ===\n');
  {
    const e = makeEnv((cmd, n) => {
      if (cmd.startsWith('OTA_BEGIN')) return ['OTA', 'BEGIN', 'OK'];
      if (cmd.startsWith('OTA_DATA')) {
        const off = Number(cmd.split(',')[1]);
        const len = (cmd.split(',')[2].length) / 2;
        return ['OTA', 'ACK', String(off + len)];
      }
      if (cmd === 'OTA_END') return ['OTA', 'END', 'OK'];
      if (cmd === 'OTA_REBOOT') return ['OTA', 'REBOOTING'];
    });
    await e.run();
    chk(countOf(e.sent, 'OTA_BEGIN') === 1, 'BEGIN 发 1 次');
    chk(countOf(e.sent, 'OTA_DATA') === 3, 'DATA 发 3 次（80 字节 → 32+32+16）', String(countOf(e.sent, 'OTA_DATA')));
    chk(countOf(e.sent, 'OTA_END') === 1 && countOf(e.sent, 'OTA_REBOOT') === 1, 'END / REBOOT 各 1 次');
  }

  console.log('\n=== 二、丢一次应答必须重试成功（这条就是修的 bug）===\n');
  {
    const e = makeEnv((cmd, n) => {
      if (cmd.startsWith('OTA_BEGIN')) return ['OTA', 'BEGIN', 'OK'];
      if (cmd.startsWith('OTA_DATA')) {
        if (cmd.startsWith('OTA_DATA,0,') && n === 1) return 'timeout';   // 第 0 包第一次丢应答
        const off = Number(cmd.split(',')[1]);
        const len = (cmd.split(',')[2].length) / 2;
        return ['OTA', 'ACK', String(off + len)];
      }
      if (cmd === 'OTA_END') return ['OTA', 'END', 'OK'];
      if (cmd === 'OTA_REBOOT') return ['OTA', 'REBOOTING'];
    });
    let threw = null;
    try { await e.run(); } catch (err) { threw = err.message; }
    chk(threw === null, '第 0 包丢一次应答后仍然升级成功', threw || '成功');
    chk(countOf(e.sent, 'OTA_DATA,0,') === 2, '第 0 包确实重发了 1 次', String(countOf(e.sent, 'OTA_DATA,0,')));
  }

  console.log('\n=== 三、连续丢应答必须报错，不能无限重试 ===\n');
  {
    const e = makeEnv((cmd, n) => {
      if (cmd.startsWith('OTA_BEGIN')) return ['OTA', 'BEGIN', 'OK'];
      if (cmd.startsWith('OTA_DATA')) {
        if (cmd.startsWith('OTA_DATA,0,')) return 'timeout';
        const off = Number(cmd.split(',')[1]);
        return ['OTA', 'ACK', String(off + (cmd.split(',')[2].length) / 2)];
      }
      if (cmd === 'OTA_END') return ['OTA', 'END', 'OK'];
      return ['OTA', 'REBOOTING'];
    });
    let threw = null;
    try { await e.run(); } catch (err) { threw = err.message; }
    chk(threw !== null, '一直丢应答 → 报错中止', threw || '竟然成功了');
    chk(countOf(e.sent, 'OTA_DATA,0,') === 3, '总共只试 3 次', String(countOf(e.sent, 'OTA_DATA,0,')));
    chk(countOf(e.sent, 'OTA_END') === 0, '失败后不会继续发 END');
  }

  console.log('\n=== 四、设备回错偏移也要重试 ===\n');
  {
    const e = makeEnv((cmd, n) => {
      if (cmd.startsWith('OTA_BEGIN')) return ['OTA', 'BEGIN', 'OK'];
      if (cmd.startsWith('OTA_DATA')) {
        if (cmd.startsWith('OTA_DATA,0,') && n === 1) return ['OTA', 'ACK', '999'];   // 偏移不对
        const off = Number(cmd.split(',')[1]);
        return ['OTA', 'ACK', String(off + (cmd.split(',')[2].length) / 2)];
      }
      if (cmd === 'OTA_END') return ['OTA', 'END', 'OK'];
      return ['OTA', 'REBOOTING'];
    });
    let threw = null;
    try { await e.run(); } catch (err) { threw = err.message; }
    chk(threw === null && countOf(e.sent, 'OTA_DATA,0,') === 2, '回错偏移 → 重发一次后成功', threw || '成功');
  }

  console.log('\n=== 五、断链时立即停止重试（不白试满 3 次）===\n');
  {
    const e = makeEnv((cmd, n) => {
      if (cmd.startsWith('OTA_BEGIN')) return ['OTA', 'BEGIN', 'OK'];
      if (cmd.startsWith('OTA_DATA')) { e.S.connected = false; e.S.writeFn = null; return 'timeout'; }
      return ['OTA', 'END', 'OK'];
    });
    let threw = null;
    try { await e.run(); } catch (err) { threw = err.message; }
    chk(threw !== null, '断链 → 报错', threw || '竟然成功了');
    chk(countOf(e.sent, 'OTA_DATA') === 1, '断链后只试了 1 次，没有白试满 3 次', String(countOf(e.sent, 'OTA_DATA')));
  }

  console.log('\n=== 六、设备明确报错时不应重试（那重试也没用）===\n');
  {
    const e = makeEnv((cmd, n) => {
      if (cmd.startsWith('OTA_BEGIN')) return ['OTA', 'ERR', 'ERASE'];
      return ['OTA', 'ERR', 'X'];
    });
    let threw = null;
    try { await e.run(); } catch (err) { threw = err.message; }
    chk(threw && threw.includes('ERASE'), 'BEGIN 被设备拒绝 → 立刻报错并带上原因', threw || '');
    chk(countOf(e.sent, 'OTA_DATA') === 0, '被拒后不会再发数据包');
  }

  console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
  process.exit(bad ? 1 : 0);
})();
