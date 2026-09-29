const { loadPage } = require('../tests/helpers/page');
(async () => {
 const e = loadPage(process.argv[2] || 'index.html');
 try {
  await e.app.openDb();
  await new Promise(r => setImmediate(r));
  if(e.errors.length || e.warnings.length) throw new Error([...e.errors,...e.warnings].join('\n'));
  console.log('PASS page loaded without errors or missing DOM elements');
 } finally { e.close(); }
})().catch(err => { console.error(err); process.exitCode=1; });
