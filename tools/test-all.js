const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter(f => /^test_.*\.js$/.test(f)).sort();
let skipped=0;
let aliasCount=0;
const aliases={'test_timeline.js':'test_integrity.js'};
let failed = 0;
for (const file of tests) {
  if(aliases[file]) {
    if(!tests.includes(aliases[file]))throw new Error('Missing test target for alias '+file);
    aliasCount++;console.log('ALIAS '+file+' -> '+aliases[file]+' (counted once)');continue;
  }
  if((file==='test_firmware_queues.js' && ['main.c','main_sta_flying_lead.c'].some(f=>!fs.existsSync(path.join(root,'stm32/User',f)))) ||
     (file==='test_ota_firmware.js' && ['ota_app.c','ota_image.h','bootloader.c'].some(f=>!fs.existsSync(path.join(root,'stm32/OTA',f))))) {
    skipped++; console.log('SKIP '+file+': local firmware sources not present (not tracked in the web repository)'); continue;
  }
  const r = spawnSync(process.execPath, [path.join(root,'tests',file)], {cwd:root,encoding:'utf8',timeout:90000});
  const ok = r.status === 0 && !r.error;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`);
  if (!ok) { failed++; console.error(r.stdout, r.stderr, r.error || ''); }
}
console.log(`${tests.length-failed-skipped-aliasCount}/${tests.length-skipped-aliasCount} independent test files passed; ${skipped} explicitly skipped; ${aliasCount} compatibility aliases; ${tests.length} discovered`);
process.exitCode = failed ? 1 : 0;
