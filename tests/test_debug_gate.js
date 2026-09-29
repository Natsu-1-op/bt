const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {loadPage}=require('./helpers/page');
(async()=>{
 assert(!fs.readFileSync(path.join(__dirname,'../blink-app.js'),'utf8').includes('DBG?'));
 for(const session of [false,true]){
  const e=loadPage('test.html',{session});
  try{
   const a=e.app;const writes=[];
   a.S.writeFn=async bytes=>writes.push(bytes);
   a.openDebugPanel();
   assert.equal(a.ui.debugPanel.classList.contains('hidden'),!session);
   await e.clock.tickAsync(30000);
   assert.equal(writes.length,0,'no hardware query or poll');
   for(const line of ['DBG,1','DBG,0','DBG,0','DBG,0'])a.parseLine(line);
   assert.equal(a.ui.debugPanel.classList.contains('hidden'),!session);
   if(session){
    a.onDisconnected();assert(!a.ui.debugPanel.classList.contains('hidden'));
    a.ui.btnDebugClose.click();assert(a.ui.debugPanel.classList.contains('hidden'));
    a.ui.appTitle.click();assert(!a.ui.debugPanel.classList.contains('hidden'));
    a.consoleLogout();a.parseLine('DBG,1');a.openDebugPanel();
    assert(a.ui.debugPanel.classList.contains('hidden'));
   }
  }finally{e.close();}
 }
 console.log('PASS password-only console: no DBG, hide/reopen/logout/disconnect');
})().catch(err=>{console.error(err);process.exitCode=1;});
