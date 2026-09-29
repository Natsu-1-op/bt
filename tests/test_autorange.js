const { readPageSource, extractFunction } = require('./helpers/source');
// 波形纵轴自适应量程的测试。
// 用法（在包根目录下）:  node tests/test_autorange.js
// 它会把 index.html 里 draw() 的量程代码块原文抽出来，用合成信号驱动，
// 检查放大倍数、灰线是否被裁掉、纯噪声会不会被放大成假波形。
const fs = require('fs');
const src = readPageSource('index.html');
const m = src.match(/    const autoOn = [\s\S]*?const y = v => clamp\(H - \(\(v - \(center - half\)\) \/ \(2 \* half\)\) \* H, -4 \* H, 5 \* H\);/);
if (!m) throw new Error('没能抽到量程代码块');
console.log('真实代码块: ' + m[0].split('\n').length + ' 行\n');

// 确定性随机（LCG）。测试必须可复现 —— 用 Math.random() 会偶发失败。
let _seed = 20260918;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const CFG = { adcMax: 4095, liveWindowMs: 8000, autoRangeMinHalf: 16 };
const H = 300;

function makeFrame() {
  const ui = { autoRange: { checked: true } };
  const S = { range: { center: null, half: CFG.adcMax / 2 } };
  return { fn: new Function('pts', 'S', 'ui', 'CFG', 'clamp', 'H',
    m[0] + '\nreturn { center, half, y };'), S, ui };
}

// base=基线 dip=眨眼深度 filtNoise=处理后噪声 rawMul=原始噪声相对倍数
// 8 点滑动平均把白噪声压到 1/sqrt(8)
function synth(base, dip, filtNoise, rawMul = 1, period = 3500) {
  const pts = [];
  for (let i = 0; i < 1600; i++) {
    const t = i * 5, ph = t % period;
    const blink = ph < 150 ? -dip * Math.sin(Math.PI * ph / 150) : 0;
    pts.push({
      t,
      raw:  base + blink + (rnd() - 0.5) * 2 * filtNoise * Math.SQRT2 * rawMul,
      filt: base + blink + (rnd() - 0.5) * 2 * filtNoise,
    });
  }
  return pts;
}

function run(name, base, dip, nz, rawMul) {
  const { fn, S, ui } = makeFrame();
  const pts = synth(base, dip, nz, rawMul);
  let r; for (let i = 0; i < 300; i++) r = fn(pts, S, ui, CFG, clamp, H);
  const { center, half, y } = r;
  const col = k => { const a = pts.map(p => p[k]); return [Math.min(...a), Math.max(...a)]; };
  const [fl, fh] = col('filt'), [rl, rh] = col('raw');
  const yF = v => H - clamp(v / CFG.adcMax, 0, 1) * H;
  const px = (lo, hi, f) => Math.abs(f(lo) - f(hi));
  const rawOn = pts.filter(p => y(p.raw) >= 0 && y(p.raw) <= H).length / pts.length;
  console.log(name);
  console.log(`  纵轴量程     : ${(center - half).toFixed(0)} … ${(center + half).toFixed(0)}  (跨度 ${(2 * half).toFixed(0)})`);
  console.log(`  绿(处理后)   : 摆幅 ${(fh - fl).toFixed(1)} → ${px(fl, fh, y).toFixed(0)}px (${(px(fl, fh, y) / H * 100).toFixed(0)}%)   固定量程时 ${px(fl, fh, yF).toFixed(1)}px`);
  console.log(`  灰(原始)     : 摆幅 ${(rh - rl).toFixed(1)} → ${px(rl, rh, y).toFixed(0)}px (${(px(rl, rh, y) / H * 100).toFixed(0)}%)   落在画布内 ${(rawOn * 100).toFixed(0)}%`);
  console.log('');
  return { green: px(fl, fh, y), greenFixed: px(fl, fh, yF), rawOn, half };
}

console.log('=== 真实量程代码块驱动 ===\n');
const a = run('① 小信号 60 counts，灰线噪声 1× （用户说看不到的那种）', 2048, 60, 4, 1);
const b = run('② 更小 25 counts，灰线噪声 1×', 2048, 25, 3, 1);
const c = run('③ 小信号 60 counts，灰线噪声 5× （灰线更脏的实际情况）', 2048, 60, 4, 5);
const d = run('④ 小信号 60 counts，灰线噪声 20× （极端）', 2048, 60, 4, 20);
const e = run('⑤ 只有噪声 ±3，没有眨眼（不应放大成假波形）', 2048, 0, 3, 1);
const f = run('⑥ 大信号 800 counts（不应削顶）', 2048, 800, 6, 3);

console.log('=== 判定 ===');
let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };
chk(a.green > 200, '① 60counts 应占满屏 200px 以上', a.green.toFixed(0) + 'px');
chk(b.green > 150, '② 25counts 也要看得见', b.green.toFixed(0) + 'px');
chk(c.green > 120, '③ 灰线脏 5× 时绿线仍要够大', c.green.toFixed(0) + 'px');
chk(d.green > 80, '④ 灰线脏 20× 时绿线仍明显大于固定量程', d.green.toFixed(0) + 'px');
chk(c.rawOn > 0.93, '③ 灰线应基本全部落在画布内', (c.rawOn * 100).toFixed(0) + '%');
chk(d.rawOn > 0.75, '④ 极端情况下灰线大部分仍在画布内', (d.rawOn * 100).toFixed(0) + '%');
chk(e.half <= CFG.autoRangeMinHalf + 0.01, '⑤ 纯噪声被半幅下限卡住', 'half=' + e.half.toFixed(1));
chk(f.green > 200, '⑥ 大信号不削顶', f.green.toFixed(0) + 'px');
chk(a.greenFixed < 10 && f.green > a.greenFixed * 20, '固定量程下小信号确实不可见（对照）', a.greenFixed.toFixed(1) + 'px');

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
