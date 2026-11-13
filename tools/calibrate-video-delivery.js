const fs = require('node:fs');
const path = require('node:path');
const {sensorTracks, beijingTimestamp} = require('../video-review');
const {loadPage} = require('../tests/helpers/page');
const {loadFrames, chooseAlignment, videoSignals, classify} = require('./fit-video-review');

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));

function write(file,data){
  const next=file+'.tmp';
  fs.writeFileSync(next,JSON.stringify(data),{mode:0o600});
  fs.renameSync(next,file);
}

function trialEvents(app,record,rows,previous){
  const start=record.metadata.first_timeline_ms;
  const {config,detector,blink_calibration:calibration}=record.metadata;
  const formal=config.blinkCalEnabled?calibration?.end_timeline_ms:detector?.calibrated_timeline_ms;
  const seed=calibration?.threshold??detector?.drop_counts??config.minDropCounts;
  const events=previous.map(event=>({event,factor:1}));
  for(const factor of [.8,.65]){
    const settings={...config,minDropCounts:config.minDropCounts*factor,noiseMultiplier:config.noiseMultiplier*factor,
      manualThresholdEnabled:false,thresholdPolicy:'adaptive-bipolar-v3'};
    const detect=app.makeOfflineDetector(settings,seed,calibration,true,true);
    const trial=rows.map(detect).filter(Boolean);
    const recovered=app.reviewIsolatedBlinks(rows,settings,trial,formal);
    for(const event of [...trial,...recovered])events.push({event,factor});
  }
  return events.map(({event,factor})=>({ms:event.t-start,amp:event.amp,event,factor}));
}

function calibrate(app,bundle,baseline,videoDir,cache,correction){
  const record=bundle.original;
  const start=record.metadata.first_timeline_ms;
  const track=sensorTracks(bundle);
  const file=correction?.video??baseline.video_file;
  const frames=loadFrames(cache,file&&path.join(videoDir,file));
  const filename=/^VID(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\./i.exec(file??'');
  const nominal=filename?track.first_utc_ms-beijingTimestamp(`${filename[1]}-${filename[2]}-${filename[3]}T${filename[4]}:${filename[5]}:${filename[6]}`):NaN;
  const base={subject:baseline.subject,video_file:file,record_id:track.record_id,first_sample_utc_ms:track.first_utc_ms,nominal_offset_ms:nominal};
  if(!frames?.some(f=>Number.isFinite(f.ear)))return {...base,status:'待人工确认',reason:'录像未提取到可用眼部关键点',alignment:null};
  const video=videoSignals(frames);
  const alignment=Number.isFinite(correction?.offset_ms)?{offset:correction.offset_ms,reliable:true,anchor:'manual'}:
    chooseAlignment(track,video,nominal);
  if(!alignment?.reliable)return {...base,status:'待人工确认',reason:'两个时间窗未能独立确认对时',alignment};
  const primary=track.reanalysis.filter(e=>e.source==='adaptive');
  const historical=bundle.reanalysis.events;
  const rows=record.sample_chunks.slice().sort((a,b)=>a.index-b.index).flatMap(c=>c.rows);
  const trials=trialEvents(app,record,rows,historical.filter(e=>e.source==='isolated-review'));
  const decision=classify({...track,events:primary},frames,video,alignment,trials);
  const accepted=decision.accepted.map(({event,video_ms,video_width_ms,eye_drop,factor})=>({event,video_ms,video_width_ms,eye_drop,threshold_factor:factor}));
  const rejected=new Set(decision.rejected.map(e=>e.sensor_ms));
  const uncertain=new Set(decision.differences.filter(e=>e.type==='仅传感器').map(e=>e.sensor));
  const confirmedEvents=historical.filter(e=>!e.source&&!rejected.has(e.t-start)&&!uncertain.has(e.t-start));
  const candidateEvents=historical.filter(e=>uncertain.has(e.t-start)||(e.source==='isolated-review'&&
    ![...confirmedEvents,...accepted.map(a=>a.event)].some(a=>Math.abs(a.t-e.t)<=250)));
  return {...base,status:decision.differences.length?'有待人工确认':'已校对',alignment,
    overlap_ms:decision.overlap_ms,matched:decision.paired.matched.length,original_differences:decision.paired.video_only.length+decision.paired.sensor_only.length,
    accepted,rejected:decision.rejected,confirmed:decision.confirmed,video_only_confirmed:decision.videoOnlyConfirmed,differences:decision.differences,
    calibrated_events:confirmedEvents.concat(accepted.map(e=>{
      const event={...e.event};delete event.source;return event;
    })).sort((a,b)=>a.t-b.t),
    calibrated_marks:confirmedEvents.concat(accepted.map(e=>e.event)).map(e=>Math.round(e.t-start)).sort((a,b)=>a-b),
    candidate_marks:candidateEvents.map(e=>Math.round(e.t-start)).sort((a,b)=>a-b),
    historical_outside_overlap:decision.paired.sensor_outside};
}

function main(){
  const [research,videoDir,out,correctionFile,outputFile]=process.argv.slice(2);
  if(!out)throw Error('用法：node tools/calibrate-video-delivery.js 研究目录 视频目录 MediaPipe复核目录 [对时修正.json] [新结果.json]');
  const index=read(path.join(research,'记录索引.json'));
  const baseline=read(path.join(out,'复核结果.json'));
  const corrections=correctionFile?read(correctionFile):{};
  const app=loadPage('test.html');
  const checkpoint=outputFile??path.join(out,'双端标定结果.json');
  const results=[];
  try{
    for(const row of index.records){
      const initial=baseline.results.find(r=>r.subject===row.subject);
      if(!initial)throw Error('缺少批量视频结果 '+row.subject);
      const bundle=read(path.join(research,row.file));
      const correction=corrections[row.subject];
      if(correction&&(typeof correction!=='object'||!Number.isFinite(correction.offset_ms)||
        (correction.video!==undefined&&(typeof correction.video!=='string'||path.basename(correction.video)!==correction.video))))
        throw Error(`${row.subject} 号对时修正无效`);
      const result=calibrate(app.app,bundle,initial,videoDir,path.join(out,'.cache'),correction);
      results.push(result);
      write(checkpoint,{schema:'blink-video-calibrated/v1',complete:false,results});
      console.log(row.subject,result.status,result.matched??0,result.accepted?.length??0,result.rejected?.length??0,result.confirmed?.length??0,result.differences?.length??0,result.alignment?.offset??'—');
    }
    write(checkpoint,{schema:'blink-video-calibrated/v1',complete:true,results});
  }finally{app.close();}
}

if(require.main===module){try{main();}catch(e){console.error(e);process.exitCode=1;}}
module.exports={write,trialEvents};
