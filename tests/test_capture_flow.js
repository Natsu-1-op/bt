const assert=require('node:assert/strict');
const {loadPage}=require('./helpers/page');
async function capture(e,planC=false){
 const a=e.app;
 a.applyConsoleConfig({noiseMultiplier:2,refractoryMs:300,minDropCounts:8,manualThresholdEnabled:true,manualDropCounts:8,blinkCalEnabled:planC,blinkCalRatio:0.6});
 a.S.connected=true;await a.beginFormalSession();
 for(let i=0;i<=2600;i++){
  const t=1000+i*5,phase=(t-5000)%1500;
  const raw=t>=5000&&phase>=0&&phase<200?2048-Math.round(40*Math.sin(Math.PI*phase/200)):2048+(i%3-1);
  a.onSample(t,raw);
 }
 await a.stopSession('user');await a.S.writeChain;
 return await a.buildBundle(JSON.parse(JSON.stringify(a.S.session)));
}
(async()=>{
 for(const page of ['index.html','test.html']){
  const e=loadPage(page);
  try{
   const a=e.app,b=await capture(e);
   assert.equal(a.S.quality.calibration_samples,541);
   assert.equal(b.metadata.detector.drop_counts,8);
   assert.equal(b.sample_chunks.reduce((n,c)=>n+c.rows.length,0),2601);
   assert.equal(a.S.count,6);
   const replay=a.makeOfflineDetector(b.metadata.config,b.metadata.detector.drop_counts);
   const events=b.sample_chunks.flatMap(c=>c.rows).map(replay).filter(Boolean);
   assert.equal(events.length,a.S.count,`${page} live/offline`);
   assert.deepEqual(events.map(e=>e.t),a.S.events.map(e=>e.t));
   await a.exportBundle();assert.equal(e.downloads.length,1);
   assert.equal(JSON.parse(await e.downloads[0].text()).metadata.id,b.metadata.id);
   a.ui.sessionList.value=b.metadata.id;await a.exportSelectedSession();
   assert.equal(e.downloads.length,2);
   await a.exportAllSessions();assert.equal(JSON.parse(await e.downloads[2].text()).session_count,1);
   assert.equal(e.errors.length,0,e.errors.join('\n'));
  }finally{e.close();}
  const e2=loadPage(page);
  try{
   const a=e2.app,b=await capture(e2,true);
   assert.equal(b.metadata.blink_calibration.accepted,5,`${page} actual Plan C must run`);
   assert.equal(a.S.count,1,'five calibration blinks excluded from formal count');
   const rows=b.sample_chunks.flatMap(c=>c.rows);
   assert.equal(rows.length,2601,'Plan C raw samples must also be retained');
   assert(rows.some(r=>r[6]&8),'Plan C samples are flagged');
   const replay=a.makeOfflineDetector(b.metadata.config,b.metadata.detector.drop_counts,b.metadata.blink_calibration);
   const replayEvents=rows.map(replay).filter(Boolean);
   assert.equal(replayEvents.length,a.S.count,'Plan C replay excludes calibration events');
   assert.deepEqual(replayEvents.map(e=>e.t),a.S.events.map(e=>e.t));
   assert.equal(b.metadata.detector.drop_counts,b.metadata.blink_calibration.threshold);
   assert.equal(e2.errors.length,0,e2.errors.join('\n'));
  }finally{e2.close();}
 }
 console.log('PASS both pages: real sample -> 541 calibration points -> 6 blinks -> IDB -> all exports; Plan C excludes 5 calibration blinks');
})().catch(err=>{console.error(err);process.exitCode=1;});
