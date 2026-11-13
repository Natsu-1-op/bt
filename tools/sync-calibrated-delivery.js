const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadPage} = require('../tests/helpers/page');
const {displaySession,beijing} = require('./export-review-delivery');
const {write} = require('./calibrate-video-delivery');

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));

function sync(source,fitFile,stage,extraFile){
  const researchName='研究用_含原始数据_勿外发';
  const hospitalName='眨眼记录回放';
  const index=read(path.join(source,researchName,'记录索引.json'));
  const fit=read(fitFile);
  assert.equal(fit.schema,'blink-video-calibrated/v1');
  assert.equal(fit.complete,true);
  assert.equal(fit.results.length,index.records.length);
  const results=new Map(fit.results.map(r=>[r.record_id,r]));
  fs.mkdirSync(stage,{mode:0o700});
  fs.cpSync(source,stage,{recursive:true});
  const file=path.join(stage,hospitalName,'播放数据.json');
  const playback=read(file);
  const work=loadPage('test.html');
  try{
    for(const row of index.records){
      const researchFile=path.join(stage,researchName,row.file);
      const input=read(researchFile);
      const fit=results.get(row.original_id);
      assert.equal(fit?.subject,row.subject);
      const view=playback.records.find(x=>x.record===row.record);
      assert.equal(view?.subject,row.subject);
      const calibration={status:fit.status,reason:fit.reason,alignment:fit.alignment,video_file:fit.video_file,
        matched:fit.matched,overlap_ms:fit.overlap_ms,historical_outside_overlap:fit.historical_outside_overlap,
        accepted:fit.accepted,rejected:fit.rejected,confirmed:fit.confirmed,video_only_confirmed:fit.video_only_confirmed,
        remaining:fit.differences,deep_review:fit.deep_review,deep_alignment:fit.deep_alignment,
        alternate_video:fit.alternate_video};
      if(fit.calibrated_events){
        input.previous_reanalysis=input.reanalysis;
        input.reanalysis={...input.reanalysis,algorithm:'replay-video-calibrated/v1',calibration_policy:'video-and-sensor-evidence',
          computed_utc_ms:Date.now(),events:fit.calibrated_events.map(e=>({...e,beijing_iso:beijing(e.utcMs)}))};
        view.marks=fit.calibrated_marks;
        view.review_marks=fit.candidate_marks;
        assert.deepEqual(input.reanalysis.events.map(e=>Math.round(e.t-input.original.metadata.first_timeline_ms)),view.marks);
      }
      input.video_calibration=calibration;
      work.app.validateImport(input);
      write(researchFile,input);
      row.video_calibration={status:fit.status,added:fit.accepted?.length??0,removed:fit.rejected?.length??0,
        pending:fit.differences?.length??null,marks:view.marks.length};
    }
    if(extraFile){
      const original=read(extraFile),m=original.metadata,subject=String(m.participant_id);
      assert(!index.records.some(r=>r.subject===subject));
      work.app.validateImport(original);
      const rows=original.sample_chunks.slice().sort((a,b)=>a.index-b.index).flatMap(c=>c.rows);
      const config={...m.config,manualThresholdEnabled:false};
      const seed=m.blink_calibration?.threshold??m.detector?.drop_counts??config.minDropCounts;
      const detect=work.app.makeOfflineDetector({...config,thresholdPolicy:'adaptive-bipolar-v3'},seed,m.blink_calibration,true,true);
      const primary=rows.map(detect).filter(Boolean);
      const formal=config.blinkCalEnabled?m.blink_calibration?.end_timeline_ms:m.detector?.calibrated_timeline_ms;
      const recovered=work.app.reviewIsolatedBlinks(rows,config,primary,formal);
      const record='R'+String(Math.max(...index.records.map(r=>Number(r.record.slice(1))))+1).padStart(3,'0');
      const started=beijing(m.created_utc_ms);
      const rel=path.join(started.slice(0,10),'受试者_'+subject,started.slice(11,19).replaceAll(':','-')+'_'+record+'.json');
      const bundle={schema:'blink-analysis/v1',original,reanalysis:{algorithm:'replay-isolated-review/v2',config,
        drop_counts:seed,calibration_policy:'reuse-original-calibration-boundary-and-baseline',computed_utc_ms:Date.now(),
        events:[...primary,...recovered].sort((a,b)=>a.t-b.t),usable:true},
        video_calibration:{status:'待配对视频',reason:'没有找到对应录像'}};
      work.app.validateImport(bundle);
      const dest=path.join(stage,researchName,rel);
      fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
      write(dest,bundle);
      playback.records.push(displaySession(original,rows,record,subject,{primary,recovered}));
      index.records.push({record,subject,original_id:m.id,beijing_start:started,status:m.status,samples:rows.length,
        saved:original.events.filter(e=>e.type==='blink').length,adaptive:primary.length,isolated:recovered.length,
        valid_formal_start:true,file:rel,video_calibration:{status:'待配对视频',marks:primary.length}});
    }
  }finally{work.close();}
  playback.records.sort((a,b)=>Number(a.subject)-Number(b.subject));
  index.records.sort((a,b)=>Number(a.subject)-Number(b.subject));
  assert.equal(playback.records.length,index.records.length);
  write(file,playback);
  write(path.join(stage,researchName,'记录索引.json'),index);
  console.log(JSON.stringify({records:index.records.length,videoCalibrated:index.records.filter(r=>r.video_calibration.added!==undefined&&r.video_calibration.pending!==null).length}));
}

if(require.main===module){
  const [source,fit,stage,extra]=process.argv.slice(2);
  if(!stage)throw Error('用法：node tools/sync-calibrated-delivery.js 原交付目录 双端标定结果.json 新目录 [单独的研究记录]');
  sync(source,fit,stage,extra);
}
