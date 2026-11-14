const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter(f => /^test_.*\.js$/.test(f)).sort();
let skipped=0;
let failed = 0;
for (const file of tests) {
  if((file==='test_firmware_queues.js' && ['main.c','main_sta_flying_lead.c'].some(f=>!fs.existsSync(path.join(root,'stm32/User',f)))) ||
     (file==='test_ota_firmware.js' && ['ota_app.c','ota_image.h','bootloader.c'].some(f=>!fs.existsSync(path.join(root,'stm32/OTA',f))))) {
    skipped++; console.log('SKIP '+file+': local firmware sources not present (not tracked in the web repository)'); continue;
  }
  const r = spawnSync(process.execPath, [path.join(root,'tests',file)], {cwd:root,encoding:'utf8',timeout:90000});
  const ok = r.status === 0 && !r.error;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`);
  if (!ok) { failed++; console.error(r.stdout, r.stderr, r.error || ''); }
}
console.log(`${tests.length-failed-skipped}/${tests.length-skipped} test files passed; ${skipped} explicitly skipped; ${tests.length} discovered`);
process.exitCode = failed ? 1 : 0;
