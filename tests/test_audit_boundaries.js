const assert=require('node:assert/strict');
const {loadPage}=require('./helpers/page');
const rec=(addr,type,data)=>{const b=[data.length,addr>>8,addr&255,type,...data];b.push((-b.reduce((s,v)=>s+v,0))&255);return ':'+b.map(v=>v.toString(16).padStart(2,'0')).join('');};
const hex=data=>[rec(0,4,[8,0]),...data,rec(0,1,[])].join('\n');
async function capture(a){
 a.applyConsoleConfig({minDropCounts:8,manualThresholdEnabled:true,manualDropCounts:8,blinkCalEnabled:false});
 a.S.connected=true;await a.beginFormalSession();
 for(let i=0;i<=2600;i++){const t=1000+i*5,p=(t-5000)%1500;a.onSample(t,t>=5000&&p>=0&&p<200?2048-Math.round(40*Math.sin(Math.PI*p/200)):2048+(i%3-1));}
 assert.equal(a.S.count,6);assert.equal(a.realtimeBpm(14000),28,'open acquisition segment contributes duration');
 await a.stopSession('user');assert.equal(a.realtimeBpm(14000),28,'closing segment must not change rate');
 return a.buildBundle(JSON.parse(JSON.stringify(a.S.session)));
}
(async()=>{
 for(const page of ['index.html','test.html']){
  const e=loadPage(page),a=e.app;
  try{
   assert.equal(a.activeDurationMs({segments:[{start_timeline_ms:1000,end_timeline_ms:null}]},1000,11000),10000);
   const b=await capture(a);a.validateImport(b);
   for(const mutate of [x=>x.metadata.config.maLength=0,x=>delete x.metadata.config.baselineAlpha,x=>x.metadata.config.releaseRatio=2,x=>x.metadata.first_timeline_ms-=1,x=>x.events[0].timeline_ms=x.metadata.last_timeline_ms+1,x=>x.metadata.segments[0].end_timeline_ms=null]){
    const bad=JSON.parse(JSON.stringify(b));mutate(bad);assert.throws(()=>a.validateImport(bad));
   }
   const legacy=JSON.parse(JSON.stringify(b));delete legacy.metadata.config.calibrationSkipMs;delete legacy.metadata.config.blinkCalEnabled;delete legacy.metadata.config.blinkCalRatio;a.validateImport(legacy);
   const vector=[0,0x50,0,0x20,9,0x20,0,8,0,0xbf];
   assert.equal(a.parseIntelHex(hex([rec(0x2000,0,vector)])).size,10);
   for(const bad of [hex([rec(0x2000,0,[0])]),hex([rec(0x2000,0,[0,0x50,0,0x20,0xff,0x7f,0,8])]),hex([rec(0x2000,0,vector),rec(0x2010,0,[255]),rec(0x2010,0,[0])])])assert.throws(()=>a.parseIntelHex(bad));
   let release;a.S.writeChain=new Promise(r=>release=r);const pending=a.analyze();await Promise.resolve();a.S.session=null;release();await pending;
   assert.equal(e.errors.length,0,e.errors.join('\n'));
  }finally{e.close();}
 }
 const e=loadPage(),a=e.app,old=[],fresh=[];
 try{
  a.S.connected=true;a.S.writeFn=async b=>old.push(b);const job=a.queueBleBytes(new Uint8Array(40));await e.clock.tickAsync(0);
  const target=new e.w.EventTarget();let notifications=0;const handler=()=>notifications++;a.S.notifyChar=target;a.S.notifyHandler=handler;target.addEventListener('characteristicvaluechanged',handler);
  a.onDisconnected();target.dispatchEvent(new e.w.Event('characteristicvaluechanged'));assert.equal(notifications,0,'listener detached');
  a.S.connected=true;a.S.writeFn=async b=>fresh.push(b);await e.clock.tickAsync(30);assert.equal(await job,false);assert.equal(old.length,1);assert.equal(fresh.length,0);
  const first=a.loadFirebase();e.w.document.querySelector('script[src*="firebase-app-compat"]').dispatchEvent(new e.w.Event('error'));assert.equal(await first,false);
  const second=a.loadFirebase();const scripts=e.w.document.querySelectorAll('script[src*="firebase-app-compat"]');assert.equal(scripts.length,2,'failed SDK attempt is retryable');
  e.w.firebase={database(){}};scripts[1].dispatchEvent(new e.w.Event('load'));e.w.document.querySelector('script[src*="firebase-database-compat"]').dispatchEvent(new e.w.Event('load'));assert.equal(await second,true);
 }finally{e.close();}
 console.log('PASS audit boundaries: live rate, strict original config, legacy defaults, vector/FF validation, analysis cancellation, BLE generation/listener cleanup, SDK retry');
})().catch(err=>{console.error(err);process.exitCode=1;});
