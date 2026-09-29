const assert=require('node:assert/strict');
const {loadPage}=require('./helpers/page');
(async()=>{
 const e=loadPage('test.html');
 try{
  const a=e.app,cloudBitmap='A5'.repeat(512);
  a.applyConsoleConfig({oledText:'测试',oledBitmap:cloudBitmap,minDropCounts:8});
  assert.equal(a.consolePayload().oledBitmap,cloudBitmap,'parameter save must preserve cloud image');
  assert.equal(a.consolePayload().oledText,'测试');
  a.S.connected=true;a.S.writeFn=async()=>{};
  a.S.oledImageBitmap=new Uint8Array(512).fill(0x33);
  const p=a.sendOledImage();await e.clock.tickAsync(500);assert.equal(await p,true);
  assert.equal(a.consolePayload().oledBitmap,'33'.repeat(512),'image send must select image for cloud save');
  assert.equal(a.readCachedDisplay().bitmapHex,'33'.repeat(512));
  a.ui.oledText.value='新文字';a.ui.oledText.oninput();assert.equal(a.S.displayMode,'text');
 }finally{e.close();}
 for(const page of ['index.html','test.html']){
  const e=loadPage(page);try{
   const a=e.app;a.S.connected=true;a.S.writeFn=async()=>{throw new Error('transport failed');};
   await assert.rejects(a.sendOtaCommand('OTA_BEGIN,8,1,1'),/transport failed/);
   assert.equal(a.S.ota.waiter,null,'failed OTA send must clear waiter for a retry');
  }finally{e.close();}
 }
 console.log('PASS OLED cloud bitmap preservation / sent-image cache; OTA failed-write waiter cleanup');
})().catch(err=>{console.error(err);process.exitCode=1;});
