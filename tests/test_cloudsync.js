const assert = require('node:assert/strict');
const {loadPage} = require('./helpers/page');
const {fakeCloud} = require('./helpers/cloud');
const config={noiseMultiplier:2,refractoryMs:0,minDropCounts:8,manualThresholdEnabled:true,manualDropCounts:8,blinkCalEnabled:false,blinkCalRatio:0.75};
(async()=>{
 for(const page of ['index.html','test.html']) {
  const c=fakeCloud(config), e=loadPage(page,{setup:w=>{w.firebase=c.cloud;}});
  try {
   const a=e.app; a.S.connected=true;
   await Promise.all([a.startWithCloudSync(),a.startWithCloudSync()]);
   assert.equal(c.reads.length,1,'double click must only start once');
   for(const [key,value] of Object.entries(config)) assert.equal(a.S.session.config[key],value,key);
   assert.equal(a.S.session.config.calibrationSkipMs,300);
   assert.equal(a.S.phase,'CAL');
   await assert.rejects(a.loadConsoleConfigFromCloud(),/先结束/);
   assert(a.ui.fMinDrop.disabled && a.ui.fBlinkCal.disabled);
   assert(a.ui.cloudGate.classList.contains('hidden'));
  }finally{e.close();}
 }
 {
  const c=fakeCloud(config),e=loadPage('test.html',{setup:w=>{w.firebase=c.cloud;}});
  try {
   const a=e.app;a.ui.fMinDrop.value='8';a.ui.manualDrop.value='8';a.ui.manualThresholdEnabled.checked=true;
   a.markConsoleConfigDirty(); const saved=await a.saveConsoleConfigToCloud();
   assert.equal(saved.manualDropCounts,8);assert.equal(saved.minDropCounts,8);
   a.ui.fMinDrop.value='12';await a.loadConsoleConfigFromCloud();assert.equal(a.ui.fMinDrop.value,'8');
   a.ui.fMinDrop.value='7';a.markConsoleConfigDirty();a.S.connected=true;
   const reads=c.reads.length;await a.startWithCloudSync();
   assert.equal(c.reads.length,reads,'local edits take priority');
   assert.equal(a.S.session.config.minDropCounts,7);
  }finally{e.close();}
 }
 for(const type of ['missing','offline','hang']) {
  const e=loadPage('index.html',{setup:w=>{
   if(type==='missing')w.firebase=fakeCloud(null).cloud;
   if(type==='hang')w.firebase={apps:[{}],database:()=>({ref:()=>({once:()=>new Promise(()=>{})})})};
   if(type==='offline')w.document.head.appendChild=el=>{queueMicrotask(()=>el.onerror());return el;};
  }});
  try{
   e.app.S.connected=true;const p=e.app.startWithCloudSync();await e.clock.tickAsync(8100);await p;
   assert.equal(e.app.S.phase,'IDLE');assert(!e.app.ui.cloudGate.classList.contains('hidden'));
   assert(e.app.ui.cloudActions.classList.contains('show'));assert.equal(e.app.S.startPending,false);
  }finally{e.close();}
 }
 {
  let reply;const pending=new Promise(r=>{reply=r;});
  const e=loadPage('test.html',{setup:w=>{w.firebase={apps:[{}],database:()=>({ref:()=>({once:()=>pending})})};}});
  try{
   e.app.S.connected=true;const p=e.app.startWithCloudSync();
   e.app.ui.fMinDrop.value='7';e.app.markConsoleConfigDirty();reply({val:()=>config});await p;
   assert.equal(e.app.S.session.config.minDropCounts,7,'late cloud response must not overwrite edits');
  }finally{e.close();}
 }
 console.log('PASS both pages: cloud config, save/read 8, snapshot, dirty edits, double start, missing/offline/timeout');
})().catch(err=>{console.error(err);process.exitCode=1;});
