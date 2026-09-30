// 本地静态服务器，只为在 http://localhost 下打开 index.html。
//
// 为什么需要它：Web Bluetooth 要求「安全上下文」——
//   https:// 和 http://localhost 都算，file:// 不算（局域网 http://10.x 也不算）。
// 只想看波形、不连设备的话，用页面里的「演示模式（无设备）」按钮即可，不需要蓝牙。
//
// 用法:  node tools/serve-page.js        （默认 8000，可用 PORT=8001 覆盖）
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.hex': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  // Explicit public assets only: never serve Git, rules, backups or symlinks.
  const publicFiles = new Set(['/index.html','/test.html','/admin.html','/blink-app.js']);
  if (!publicFiles.has(rel)) { res.writeHead(403); res.end('403 forbidden'); return; }

  // 归一化后确认仍在 ROOT 之内，防止 ../ 穿越
  const file = path.resolve(ROOT, '.' + path.posix.normalize(rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 forbidden');
    return;
  }

  try {
    if (fs.lstatSync(file).isSymbolicLink()) { res.writeHead(403); res.end('403 forbidden'); return; }
  } catch (_) { res.writeHead(404); res.end('404 not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',   // 改完刷新就能看到，不会被浏览器缓存骗到
    });
    res.end(buf);
  });
});

server.on('error', (e) => {
  console.error('起不来:', e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，换一个: PORT=8001 node tools/serve-page.js` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本机打开:   http://localhost:${PORT}/`);
  console.log('看波形: 点页面底部「演示模式（无设备）」，再切换右上角「纵轴自动量程」复选框对比。');
});
