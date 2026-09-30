const assert=require('node:assert/strict');
const {loadPage}=require('./helpers/page');
const {fakeCloud}=require('./helpers/cloud');
(async()=>{
 const e=loadPage('test.html',{setup:w=>{w.firebase=fakeCloud().cloud;}});
 try{
  const a=e.app;
  for(const char of ['.','#','$','/','[',']','\u0001','\u007f']){
   a.ui.loginPass.value='bad'+char+'key';await a.submitConsoleLogin();
   assert.match(a.ui.loginError.textContent,/格式不合法/);
  }
  assert(!a.ui.loginGate.classList.contains('hidden'));
  assert(a.ui.debugPanel.classList.contains('hidden'));
  a.ui.loginPass.value='wrong';await a.submitConsoleLogin();
  assert.equal(a.S.consoleAuthenticated,false);assert.match(a.ui.loginError.textContent,/密码不对/);
  a.ui.loginPass.value='test-secret';await a.submitConsoleLogin();
  assert.equal(a.S.consoleAuthenticated,true);assert(a.ui.loginGate.classList.contains('hidden'));
  assert(!a.ui.debugPanel.classList.contains('hidden'),'password alone opens the console without a device');
  a.consoleLogout();assert.equal(a.S.consoleAuthenticated,false);assert.equal(a.consoleSessionValid(),false);
 }finally{e.close();}
 const cached=loadPage('test.html',{session:true});
 try{assert.equal(cached.app.S.consoleAuthenticated,true);assert(!cached.app.ui.debugPanel.classList.contains('hidden'));}finally{cached.close();}
 console.log('PASS password/cached login opens the console; logout requires password again');
})().catch(err=>{console.error(err);process.exitCode=1;});
