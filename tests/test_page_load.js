const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const runner = path.join(root, 'tools/run-page.js');
assert(fs.existsSync(runner), 'Missing tools/run-page.js');
for (const page of ['index.html','test.html']) {
  const r = spawnSync(process.execPath, [runner,page], {cwd:root,encoding:'utf8'});
  assert.equal(r.status,0,`${page}: ${r.stdout}\n${r.stderr}`);
}
assert.notEqual(spawnSync(process.execPath,[runner,'missing.html'],{cwd:root,stdio:'ignore'}).status,0);
console.log('PASS both complete pages load; missing files fail loudly');
