const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter(f => /^test_.*\.js$/.test(f) && !['test_firmware_queues.js','test_timeline.js'].includes(f)).sort();
let failed = 0;
for (const file of tests) {
  const r = spawnSync(process.execPath, [path.join(root,'tests',file)], {cwd:root,encoding:'utf8',timeout:90000});
  const ok = r.status === 0 && !r.error;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`);
  if (!ok) { failed++; console.error(r.stdout, r.stderr, r.error || ''); }
}
console.log(`${tests.length-failed}/${tests.length} test files passed`);
process.exitCode = failed ? 1 : 0;
