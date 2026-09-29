const { readPageSource, extractFunction } = require('./helpers/source');
// 连上设备后自动推送显示内容的测试。
// 用法（包根目录）: node tests/test_autodisplay.js
// 抽的是 index.html 里真实的 autoPushDisplay 及配套函数。
const fs = require('fs');
const src = readPageSource(process.argv[2] || 'index.html');

const m = src.match(/  const DISPLAY_CACHE_KEY[\s\S]*?return queueBleText\('T,' \+ hex \+ '\\n'\);\n  \}\n/);
if (!m) throw new Error('没能抽到 autoPushDisplay 代码块');
console.log('抽取真实代码: ' + m[0].split('\n').length + ' 行\n');

const DEFAULT_TEXT = '眨眼采集';

function makeEnv({ cloud = null, cache = null, connected = true, cloudThrows = false, renderThrows = false } = {}) {
  const store = new Map();
  if (cache) store.set('blink-display-v1', JSON.stringify(cache));
  const sent = [], rendered = [];
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const S = { connected, writeFn: connected ? () => {} : null };
  const api = new Function('S', 'localStorage', 'fetchConsoleConfig', 'bytesToHex', 'renderOledText', 'queueBleText',
    m[0] + '\nreturn { autoPushDisplay, isValidDisplayHex, readCachedDisplay, cacheDisplay };');
  const inst = api(
    S, localStorage,
    async () => { if (cloudThrows) throw new Error('offline'); return cloud; },
    b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase(),
    text => {
      if (renderThrows) throw new Error('no canvas');
      rendered.push(text);
      const a = new Uint8Array(512); a[0] = 0xAA; return a;
    },
    async line => { sent.push(line); return true; });
  return { ...inst, sent, rendered, store, S };
}

const HEX512 = 'AB'.repeat(512);
let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };
const pushed = e => e.sent.length === 1 && e.sent[0].slice(2, -1).length === 1024;

(async () => {
  console.log('=== 一、有云端内容就用云端的 ===\n');
  {
    const e = makeEnv({ cloud: { oledText: '眨眼采集', oledBitmap: HEX512 } });
    await e.autoPushDisplay();
    chk(e.sent.length === 1 && e.sent[0].slice(2, -1) === HEX512, '① 云端有文字+位图：直接发那张位图');
    chk(e.store.has('blink-display-v1'), '① 顺便写进本机缓存');
  }
  {
    const e = makeEnv({ cloud: { oledText: '受试者 P001' } });
    await e.autoPushDisplay();
    chk(pushed(e) && e.rendered[0] === '受试者 P001', '② 云端只有文字：本机渲染它再发', `渲染了「${e.rendered[0]}」`);
  }
  {
    const e = makeEnv({ cloudThrows: true, cache: { text: '缓存文字', bitmapHex: HEX512 } });
    await e.autoPushDisplay();
    chk(e.sent.length === 1 && e.sent[0].slice(2, -1) === HEX512, '③ 没网但有缓存：用缓存发');
  }

  console.log('\n=== 二、什么都没有时兜底到默认文字（这次修的就是这里）===\n');
  {
    const e = makeEnv({ cloudThrows: true, cache: null });
    await e.autoPushDisplay();
    chk(pushed(e), '④ 没网且没缓存：仍然要发，不能空着屏幕');
    chk(e.rendered[0] === DEFAULT_TEXT, `④ 发的是默认文字「${DEFAULT_TEXT}」`, `实际渲染「${e.rendered[0]}」`);
    chk(e.store.has('blink-display-v1'), '④ 默认内容也写进缓存，下次不用再渲染');
  }
  {
    const e = makeEnv({ cloud: null });
    await e.autoPushDisplay();
    chk(pushed(e) && e.rendered[0] === DEFAULT_TEXT, '⑤ 云端节点是空的：兜底默认文字');
  }
  {
    const e = makeEnv({ cloud: { oledText: '', oledBitmap: 'FF' } });
    await e.autoPushDisplay();
    chk(pushed(e) && e.rendered[0] === DEFAULT_TEXT, '⑥ 云端位图长度非法且没有文字：兜底默认文字');
  }
  {
    const e = makeEnv({ cloud: { oledText: '云端文字', oledBitmap: 'FF' } });
    await e.autoPushDisplay();
    chk(pushed(e) && e.rendered[0] === '云端文字', '⑦ 云端位图坏了但文字在：优先用文字，不降到默认');
  }

  console.log('\n=== 三、仍然必须【不发】的情况 ===\n');
  {
    const e = makeEnv({ connected: false });
    const ok = await e.autoPushDisplay();
    chk(ok === false && e.sent.length === 0, '⑧ 没连上设备：一条都不发', `发送 ${e.sent.length} 条`);
  }
  {
    const e = makeEnv({ cloudThrows: true, renderThrows: true });
    const ok = await e.autoPushDisplay();
    chk(ok === false && e.sent.length === 0, '⑨ 渲染不出任何有效位图：不发（发出去只会刷白屏幕）', `发送 ${e.sent.length} 条`);
  }

  console.log('\n=== 四、位图校验 ===\n');
  {
    const e = makeEnv({});
    chk(e.isValidDisplayHex(HEX512), '⑩ 1024 个 hex 字符 → 合法');
    chk(!e.isValidDisplayHex('FF') && !e.isValidDisplayHex(HEX512 + 'AB'), '⑩ 长度不对 → 非法');
    chk(!e.isValidDisplayHex('ZZ'.repeat(512)), '⑩ 非 hex 字符 → 非法');
    chk(!e.isValidDisplayHex(null) && !e.isValidDisplayHex(undefined), '⑩ null/undefined → 非法');
  }

  console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
  process.exit(bad ? 1 : 0);
})();
