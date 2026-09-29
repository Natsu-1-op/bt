const { readPageSource, extractFunction } = require('./helpers/source');
// 用真实固件 hex 跑一遍页面的 OTA 解析链路。
// 用法（包根目录）: node tests/test_ota_parse.js
// 抽的是 index.html 里真实的 parseIntelHex / crc32 / crc16 / hexBytes，不是复制品。
// 若包内没有 stm32/gcc/build/Project.hex（编译产物不随包发布），则跳过与 bin 的比对。
const fs = require('fs');
const path = require('path');

const src = readPageSource(process.argv[2] || 'index.html');
function grab(name) { return extractFunction(src, name); }
const consts = src.match(/  const OTA_APP_BASE[\s\S]*?OTA_PACKET_BYTES = \d+;/);
if (!consts) throw new Error('找不到 OTA 常量');
const F = new Function([
  consts[0],
  grab('bytesToHex'), grab('hexBytes'), grab('parseIntelHex'),
  grab('crc32Bytes'), grab('crc16Ccitt'),
].join('\n') + '\nreturn { bytesToHex, hexBytes, parseIntelHex, crc32Bytes, crc16Ccitt };')();

const APP_BASE = 0x08002000, APP_END = 0x08008000, APP_MAX = APP_END - APP_BASE;
let bad = 0;
const chk = (ok, msg, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? '  → ' + extra : ''}`); if (!ok) bad++; };

// ---------- 一、坏输入必须全被拒（这是 OTA 的最后一道闸）----------
console.log('=== 一、坏输入必须被拒 ===\n');
const goodLine = ':1020000000500020B5360008893B00088B3B0008D3';   // 任取一条合法数据行
// 用真算校验和的方式构造测试记录。手写校验和很容易算错，
// 那会让测试「因为算错了才通过」，测不到真正想测的那条规则。
const mk = (type, addr, bytes) => {
  const rec = [bytes.length, (addr >> 8) & 0xff, addr & 0xff, type, ...bytes];
  const sum = rec.reduce((a, b) => (a + b) & 0xff, 0);
  return ':' + rec.concat([(0x100 - sum) & 0xff]).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
};
const EXT = (upper) => mk(4, 0, [(upper >> 8) & 0xff, upper & 0xff]);
const EOF = mk(1, 0, []);
const noEof = [':020000040800F2', goodLine].join('\n');
const corrupt = [':020000040800F2', goodLine.slice(0, -2) + (goodLine.slice(-2) === '00' ? '01' : '00'), ':00000001FF'].join('\n');
const cases = [
  ['校验和错', corrupt, '校验和'],
  ['记录长度不符', ':0110000000', '长度'],
  ['完全不是 hex', 'hello world', '格式'],
  ['缺少结束记录', noEof, '结束记录'],
  ['只有结束记录', ':00000001FF', '0x08002000'],
  // 这一条最要紧：含 Bootloader 的整片 HEX 必须拒收（README 里专门警告过）
  ['含 Bootloader 的整片 hex（从 0x08000000 开始）',
   [EXT(0x0800), mk(0, 0x0000, [0, 0, 0, 0]), EOF].join('\n'), '0x08002000'],
  ['地址越过应用区上界',
   [EXT(0x0801), mk(0, 0x0000, [0, 0, 0, 0]), EOF].join('\n'), '超出应用区'],
];
for (const [name, input, expectWord] of cases) {
  let threw = false, msg = '';
  try { F.parseIntelHex(input); } catch (e) { threw = true; msg = e.message; }
  const ok = threw && (!expectWord || msg.includes(expectWord));
  chk(ok, `拒绝：${name}`, threw ? msg.slice(0, 46) : '竟然接受了');
}

// ---------- 二、真实固件 hex（若包内存在编译产物）----------
console.log('\n=== 二、真实固件 hex ===\n');
const HEX = process.argv[3] || 'stm32/gcc/build/Project.hex';
if (!fs.existsSync(HEX)) {
  console.log(`  跳过：包内没有 ${HEX}（编译产物不随包发布，需要时在 stm32/gcc 里跑 ./build.sh）`);
} else {
  const text = fs.readFileSync(HEX, 'utf8');
  let res;
  try { res = F.parseIntelHex(text); chk(true, '解析成功'); }
  catch (e) { chk(false, '解析失败: ' + e.message); }
  if (res) {
    console.log(`  镜像 ${res.size} 字节 = ${(res.size / 1024).toFixed(2)} KiB，CRC32 = 0x${res.crc32.toString(16).toUpperCase().padStart(8, '0')}`);
    chk(res.size > 0 && res.size <= APP_MAX, '镜像不超过应用区 24 KiB', `${res.size} / ${APP_MAX}`);
    const binPath = path.join(path.dirname(HEX), 'Project.bin');
    if (fs.existsSync(binPath)) {
      const bin = fs.readFileSync(binPath);
      let diff = bin.length !== res.size ? -2 : -1;
      if (diff === -1) for (let i = 0; i < bin.length; i++) if (bin[i] !== res.image[i]) { diff = i; break; }
      chk(diff === -1, '解析结果与 objcopy 的 .bin 逐字节一致',
          diff === -1 ? `${bin.length} 字节全同` : (diff === -2 ? `长度 ${res.size} vs ${bin.length}` : `第 ${diff} 字节不同`));
      chk(F.crc32Bytes(bin) === res.crc32, '两条路径算出的 CRC32 相同');
    }
    const b = res.image;
    const u32 = o => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const sp = u32(0), rv = u32(4);
    console.log(`  栈顶=0x${sp.toString(16).toUpperCase()}  复位向量=0x${rv.toString(16).toUpperCase()}`);
    chk(sp >= 0x20000000 && sp < 0x20010000, '栈顶指针落在 SRAM 内');
    chk(rv >= APP_BASE && rv < APP_END, '复位向量落在应用区内（链接地址正确）');
  }
}

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
