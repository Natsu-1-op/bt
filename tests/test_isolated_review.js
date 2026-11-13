const assert = require('node:assert/strict');
const {loadPage}=require('./helpers/page');

(async()=>{
  const page=loadPage('test.html',{session:true});
  const {app:a,clock}=page;
  try {
    a.applyConsoleConfig({minDropCounts:8,noiseMultiplier:4,blinkCalEnabled:false,manualThresholdEnabled:true,manualDropCounts:80});
    a.S.connected=true;
    await a.beginFormalSession();
    for(let t=1000;t<=11500;t+=5) {
      let raw=2048 + (t/5)%3 - 1;
      for (const [start,amp] of [[5100,19],[6700,-20]]) {
        if(t>=start&&t<start+130)raw+=amp*Math.sin(Math.PI*(t-start)/130);
      }
      if(t===8200)raw+=150; // moving-average smear must not make this one ADC impulse a blink
      if(t>=9500&&t<10700)raw+=80; // long level jump
      a.onSample(t,Math.round(raw));
    }
    await a.stopSession('user_stop');
    const snapshot=JSON.stringify(a.S.session);
    const bundle=await a.buildBundle(a.S.session);
    const rows=bundle.sample_chunks.flatMap(c=>c.rows);
    const formal=bundle.metadata.detector.calibrated_timeline_ms;
    const config=bundle.metadata.config;
    const review=a.reviewIsolatedBlinks(rows,config,[],formal);
    assert.equal(review.length,2);
    assert.equal(review.map(e=>e.polarity).join(','),'rise,fall');
    assert(review.every(e=>e.threshold_counts<80&&e.source==='isolated-review'));
    assert.equal(a.reviewIsolatedBlinks(rows,config,[{t:5110,width:120}],formal).length,1);
    const split=rows.map(row=>row[0]>=5160?[...row.slice(0,5),2,row[6]]:row);
    assert.equal(a.reviewIsolatedBlinks(split,config,[],formal).length,1);
    assert.equal(a.reviewIsolatedBlinks(rows,config,[],undefined).length,0);

    await a.startReplay();
    const task=a.applyReplayTrial(true,true);
    await clock.tickAsync(150);
    await task;
    const trial=a.S.replay.trial;
    assert.equal(trial.algorithm,'replay-isolated-review/v2');
    assert(trial.events.some(e=>e.source==='isolated-review'));
    assert.equal(JSON.stringify(a.S.session),snapshot);
    await a.exportReplayComparison();
    const json=JSON.parse(await page.downloads.at(-1).text());
    assert.equal(a.validateImport(json).length,1);
    const bad=structuredClone(json);
    bad.reanalysis.events.find(e=>e.source).source='confirmed';
    assert.throws(()=>a.validateImport(bad),/试调事件无效/);
    const [id]=await a.importData(json);
    a.ui.sessionList.value=id;
    await a.loadSelectedSession();
    await a.startReplay();
    assert.equal(JSON.stringify(a.S.replay.trial.events),JSON.stringify(trial.events));
    assert.equal(page.errors.length,0,page.errors.join('\n'));
  } finally {page.close();}
  console.log('PASS weak rise/fall recovered offline; rejects impulse, level jump and segment crossing; review round-trips');
})().catch(err=>{console.error(err);process.exitCode=1;});
