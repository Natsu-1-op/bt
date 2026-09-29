const assert=require('node:assert/strict');
const {loadPage}=require('./helpers/page');
(async()=>{
 const normal=loadPage('index.html');
 try{
  assert.equal(normal.w.document.getElementById('dataWorkbench'),null);
  assert.equal(normal.w.document.getElementById('importFile'),null);
  await assert.rejects(()=>normal.app.importData({}),/控制台/);
  await assert.rejects(()=>normal.app.startReplay(),/控制台/);
 }finally{normal.close();}
 const locked=loadPage('test.html');
 try{await assert.rejects(()=>locked.app.importData({}),/登录/);await assert.rejects(()=>locked.app.startReplay(),/登录/);}finally{locked.close();}
 for(const page of ['test.html']){
  const e=loadPage(page,{session:true});
  try{
   const a=e.app;
   assert(e.w.document.getElementById('replayRecords').contains(a.ui.sessionList));
   assert.equal(e.w.document.querySelectorAll('#sessionList').length,1);
   a.applyConsoleConfig({minDropCounts:0,manualDropCounts:2,manualThresholdEnabled:true,noiseMultiplier:0});
   assert.equal(a.currentConfig().minDropCounts,0);
   assert.equal(a.currentConfig().manualDropCounts,2);
   assert.equal(a.currentConfig().noiseMultiplier,0);
   a.S.connected=true;await a.beginFormalSession();
   for(let i=0;i<2000;i++)a.onSample(1000+i*5,2048+(i%3-1));
   await a.stopSession('user');
   const original=await a.buildBundle(JSON.parse(JSON.stringify(a.S.session)));
   const saved=JSON.stringify(original);
   const ids=await a.importData({schema:'blink-export-all/v1',sessions:[original,original]});
   assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.notEqual(ids[0],original.metadata.id);
   assert.equal(JSON.stringify(original),saved,'import must not mutate input');
   const imported=await a.buildBundle(await a.readSessionRecord(ids[0]));
   assert.equal(imported.metadata.created_utc_ms,original.metadata.created_utc_ms);
   assert.deepEqual(imported.sample_chunks.flatMap(c=>c.rows),original.sample_chunks.flatMap(c=>c.rows));
   assert.equal(imported.metadata.import_source_id,original.metadata.id);
   const bad=JSON.parse(saved);bad.sample_chunks[0].rows[0][3]=-1;
   const before=a.ui.sessionList.options.length;
   await assert.rejects(()=>a.importData({schema:'blink-export-all/v1',sessions:[original,bad]}));
   await a.refreshSessionList();assert.equal(a.ui.sessionList.options.length,before,'invalid batch writes nothing');
   a.ui.sessionList.value=ids[0];await a.loadSelectedSession();
   const snapshot=JSON.stringify(a.S.session),writes=[];
   a.S.writeFn=async bytes=>writes.push(bytes);
   await a.startReplay();assert(a.S.replay.playing);
   await e.clock.tickAsync(1000);
   assert(a.S.replay.position>a.S.replay.start);
   await a.startReplay();const pos=a.S.replay.position;
   await e.clock.tickAsync(500);assert.equal(a.S.replay.position,pos,'paused');
   a.seekReplay(a.S.replay.start+5000);
   assert.equal(a.S.replay.position,a.S.replay.start+5000);
   e.w.document.getElementById('replaySpeed').value='4';
   await a.startReplay();await e.clock.tickAsync(2000);
   assert.equal(a.S.replay.position,a.S.replay.end);assert.equal(a.S.replay.playing,false);
   assert.equal(writes.length,0,'no replay stats sent to device');
   assert.equal(JSON.stringify(a.S.session),snapshot,'replay never changes record');
   a.stopReplay();assert.equal(a.S.replay,null);
   a.S.phase='RUN';await assert.rejects(()=>a.importData(original));
   assert.equal(e.errors.length,0,e.errors.join('\n'));
  }finally{e.close();}
 }
 console.log('PASS console-only import/replay, login required, unique record controls, atomic import, timestamps, playback and no BLE writes');
})().catch(err=>{console.error(err);process.exitCode=1;});
