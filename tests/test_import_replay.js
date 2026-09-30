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
   const viewport=e.w.document.querySelector('.replay-viewport');
   assert(viewport.contains(e.w.document.getElementById('scope')));
   assert(viewport.contains(e.w.document.getElementById('replaySeek')));
   const seek=e.w.document.getElementById('replaySeek');
   seek.dispatchEvent(new e.w.Event('pointerdown'));
   const dragPosition=a.S.replay.position;
   await e.clock.tickAsync(100);assert.equal(a.S.replay.position,dragPosition,'slider is not fought by playback');
   seek.value='1000';seek.dispatchEvent(new e.w.Event('input'));
   assert.equal(a.S.replay.position,a.S.replay.start+1000);
   e.w.dispatchEvent(new e.w.Event('pointerup'));assert(a.S.replay.playing);
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
   e.w.document.getElementById('trialDrop').value='1';
   e.w.document.getElementById('trialRefractory').value='100';
   const trial=a.applyReplayTrial();await e.clock.tickAsync(100);await trial;
   assert.equal(a.S.replay.trial.drop_counts,1);
   assert.equal(a.S.replay.trial.config.refractoryMs,100);
   assert.equal(a.S.session.config.refractoryMs,300,'original parameter retained');
   await a.exportReplayComparison();
   const compared=JSON.parse(await e.downloads.at(-1).text());
   assert.equal(compared.schema,'blink-analysis/v1');
   assert.equal(compared.original.metadata.detector.drop_counts,2);
   assert.equal(compared.reanalysis.drop_counts,1);
   assert.deepEqual(compared.original.sample_chunks.flatMap(c=>c.rows),JSON.parse(saved).sample_chunks.flatMap(c=>c.rows));
   e.w.document.getElementById('trialDrop').value='500';
   const older=a.applyReplayTrial();
   e.w.document.getElementById('trialDrop').value='3';
   const latest=a.applyReplayTrial();await e.clock.tickAsync(100);await Promise.all([older,latest]);
   assert.equal(a.S.replay.trial.drop_counts,3,'late computation cannot overwrite newer input');
   e.w.document.getElementById('trialReset').click();assert.equal(a.S.replay.trial,null);
   assert.equal(JSON.stringify(a.S.session),snapshot,'replay never changes record');
   a.stopReplay();assert.equal(a.S.replay,null);

   // —— 对比文件必须能导回来 ——
   // 曾经导不回来：validateImport 只认 blink-export-all/v1 和 blink-export/v1，
   // 自己导出的 blink-analysis/v1 会被判「文件结构或数据列不受支持」。
   const comparedSaved=JSON.stringify(compared);
   const cmpIds=await a.importData(compared);
   assert.equal(cmpIds.length,1,'comparison file imports as one record');
   assert.equal(JSON.stringify(compared),comparedSaved,'import must not mutate the comparison input');
   const cmpBundle=await a.buildBundle(await a.readSessionRecord(cmpIds[0]));
   // 用 JSON 归一化后再比：对比文件是走 JSON 落盘的，JSON 会把 -0 变成 0，
   // 而 IndexedDB（结构化克隆）保留 -0 —— 直接 deepEqual 会因为这个假差异挂掉。
   // 比 JSON 形式才是「文件往返」的正确语义。
   assert.equal(JSON.stringify(cmpBundle.sample_chunks.flatMap(c=>c.rows)),
                JSON.stringify(compared.original.sample_chunks.flatMap(c=>c.rows)),
                'imported rows survive the comparison round-trip');
   assert.equal(cmpBundle.sample_chunks.flatMap(c=>c.rows).length,2000);
   // 打开并重放：当时那次试调应该自动恢复，否则「导出对比」等于有去无回
   a.ui.sessionList.value=cmpIds[0];await a.loadSelectedSession();await a.startReplay();
   assert(a.S.replay.trial,'trial restored from comparison file');
   assert.equal(a.S.replay.trial.drop_counts,compared.reanalysis.drop_counts);
   assert.equal(a.S.replay.trial.events.length,compared.reanalysis.events.length);
   assert.equal(a.S.replay.trial.restored_from_file,true);
   assert.equal(e.w.document.getElementById('trialDrop').value,String(compared.reanalysis.drop_counts));
   await a.exportReplayComparison();
   const repeated=JSON.parse(await e.downloads.at(-1).text());
   assert.equal(repeated.original.metadata.reanalysis,undefined,'old trial must not be nested in original');
   for(const mutate of [
     b=>b.reanalysis.drop_counts=-1,
     b=>delete b.reanalysis.config,
     b=>b.reanalysis.config.refractoryMs=-1,
     b=>b.reanalysis.config.maLength=999,
     b=>b.reanalysis.events=[{t:1e10,utcMs:1,width:10,amp:1}],
   ]){
     const malformed=JSON.parse(comparedSaved);mutate(malformed);
     await assert.rejects(()=>a.importData(malformed));
     const plain={...malformed.original,metadata:{...malformed.original.metadata,reanalysis:malformed.reanalysis}};
     await assert.rejects(()=>a.importData(plain),'same validation on plain-file metadata');
     await assert.rejects(()=>a.importData({schema:'blink-export-all/v1',sessions:[plain]}));
   }
   const retained=a.S.replay;
   e.w.sessionStorage.clear();a.S.replay.playing=true;a.tickReplay();
   assert.equal(a.S.replay,retained,'expiry pauses without destroying trial');
   assert.equal(retained.playing,false);
   a.openDebugPanel();assert.equal(a.S.replay,retained,'login dialog retains trial');
   e.w.sessionStorage.setItem('blink-console-auth-v1',JSON.stringify({expiresAt:e.w.Date.now()+1800000}));a.showConsole('');
   a.stopReplay();
   const damaged=await a.readSessionRecord(cmpIds[0]);
   damaged.reanalysis={events:[],drop_counts:5};
   const db=await a.openDb();
   await new Promise((resolve,reject)=>{
     const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put(damaged);
     tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
   });
   a.S.session=null;a.ui.sessionList.value=damaged.id;await a.loadSelectedSession();
   const storedBefore=JSON.stringify(await a.readSessionRecord(damaged.id));
   await a.startReplay();
   assert(a.S.replay.playing,'damaged optional trial must not block playback');
   assert.equal(a.S.replay.trial,null);
   assert.match(e.w.document.getElementById('trialStatus').textContent,/旧试调结果无法恢复/);
   await e.clock.tickAsync(100);assert(a.S.replay.position>a.S.replay.start);
   e.w.document.getElementById('trialDrop').value='2';
   const repair=a.applyReplayTrial();await e.clock.tickAsync(100);await repair;
   await a.exportReplayComparison();
   const repaired=JSON.parse(await e.downloads.at(-1).text());
   assert(a.validateImport(repaired).length===1,'new trial exports a valid comparison from old damaged records');
   assert.equal(JSON.stringify(await a.readSessionRecord(damaged.id)),storedBefore,'fallback never edits stored data');
   a.stopReplay();
   // 残缺的对比文件必须明确拒收，而不是导进一条缺试调的记录
   await assert.rejects(()=>a.importData({schema:'blink-analysis/v1',original:compared.original}),/reanalysis/);
   await assert.rejects(()=>a.importData({schema:'blink-analysis/v1',reanalysis:compared.reanalysis}),/original/);

   a.S.phase='RUN';await assert.rejects(()=>a.importData(original));
   assert.equal(e.errors.length,0,e.errors.join('\n'));
  }finally{e.close();}
 }
 console.log('PASS console-only import/replay, login required, unique record controls, atomic import, timestamps, playback and no BLE writes');
})().catch(err=>{console.error(err);process.exitCode=1;});
