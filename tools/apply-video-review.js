const fs = require('node:fs');
const path = require('node:path');
const {sensorTracks} = require('../video-review');
const {loadPage} = require('../tests/helpers/page');
const {trialEvents} = require('./calibrate-video-delivery');

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const decisions = new Set(['是眨眼','非眨眼','看不清']);

function applyMarks(input, files, loadRecord, findResponse){
  if(input.schema!=='blink-video-calibrated/v1'||!input.complete)throw Error('请选择已完成的双端标定结果。');
  const batch=structuredClone(input);
  const records=new Map(batch.results.map(r=>[r.record_id,r]));
  const marks=new Map();
  const issues=[];
  for(const file of files){
    if(!['blink-video-review-labels/v1','blink-video-review-labels/v2'].includes(file.schema)||!Array.isArray(file.marks))
      throw Error('请选择有效的复核标记文件。');
    for(const mark of file.marks){
      const row=records.get(mark?.record_id);
      if(!row||row.subject!==mark.subject||row.video_file!==mark.video_file||!decisions.has(mark.decision)){
        issues.push({mark,reason:'记录、录像或判定不匹配'});continue;
      }
      if(!row.alignment?.reliable||!Number.isFinite(mark.offset_ms)||Math.abs(row.alignment.offset-mark.offset_ms)>1){
        issues.push({mark,reason:'对时已调整，需用修正后的时间重新生成差异清单'});continue;
      }
      if(!Number.isFinite(mark.video_ms)||!Number.isFinite(mark.sensor_ms)){
        issues.push({mark,reason:'标记时间无效'});continue;
      }
      const difference=row.differences.find(d=>d.type===mark.type&&Math.abs(d.video-(mark.source_video_ms??mark.video_ms))<.01&&
        Math.abs(d.sensor-(mark.source_sensor_ms??mark.sensor_ms))<.01&&Math.abs(d.video-mark.video_ms)<.01&&Math.abs(d.sensor-mark.sensor_ms)<.01);
      if(!difference){issues.push({mark,reason:'当前差异清单中没有该时间点'});continue;}
      const key=JSON.stringify([row.record_id,difference.video,difference.sensor,difference.type]);
      const entry=marks.get(key);
      if(entry)entry.decisions.add(mark.decision);
      else marks.set(key,{row,difference,decisions:new Set([mark.decision])});
    }
  }

  let applied=0,kept=0;
  const sourceRecords=new Map();
  const ordered=[...marks.values()].sort((a,b)=>Number(a.difference.type==='仅视频')-Number(b.difference.type==='仅视频'));
  for(const {row,difference,decisions:choices} of ordered){
    if(choices.size!==1){issues.push({subject:row.subject,difference,reason:'多个文件对同一事件给出了不同判定'});continue;}
    const [decision]=choices;
    if(decision==='看不清'){kept++;continue;}
    if(!sourceRecords.has(row.record_id))sourceRecords.set(row.record_id,loadRecord(row));
    const bundle=sourceRecords.get(row.record_id);
    const origin=bundle.original.metadata.first_timeline_ms;
    const time=difference.sensor;
    const candidates=row.candidate_marks;
    const primary=row.calibrated_events;
    const history=bundle.reanalysis.events;
    let action;
    if(difference.type==='仅传感器'){
      const original=history.find(e=>!e.source&&Math.abs(e.t-origin-time)<.01);
      if(!original){issues.push({subject:row.subject,difference,reason:'传感器标记没有对应的历史事件'});continue;}
      if(decision==='是眨眼'){
        if(!primary.some(e=>Math.abs(e.t-original.t)<.01))primary.push(original);
        action='保留传感器事件';
      }else{
        row.calibrated_events=primary.filter(e=>Math.abs(e.t-original.t)>=.01);
        action='排除传感器事件';
      }
      row.candidate_marks=candidates.filter(ms=>ms!==Math.round(time));
    }else if(difference.type!=='仅视频'){
      issues.push({subject:row.subject,difference,reason:'这类试算标记需要在正式差异页确认'});continue;
    }else if(decision==='非眨眼'){
      action='排除视频标记';
    }else{
      const response=findResponse(bundle,difference,row);
      if(response){
        const event={...response};delete event.source;
        primary.push(event);
        row.candidate_marks=candidates.filter(ms=>Math.abs(ms-(event.t-origin))>200);
        action='补回传感器事件';
      }else if(row.calibrated_marks.some(ms=>Math.abs(ms-time)<=150)){
        action='已有对应传感器事件';
      }else{
        row.video_only_confirmed.push({sensor_ms:time,video_ms:difference.video,method:'manual'});
        action='确认仅视频';
      }
    }
    row.calibrated_events.sort((a,b)=>a.t-b.t);
    row.calibrated_marks=row.calibrated_events.map(e=>Math.round(e.t-origin));
    row.differences=row.differences.filter(d=>d!==difference);
    row.status=row.differences.length?'有待人工确认':'已校对';
    (row.manual_review??=[]).push({difference:{type:difference.type,video:difference.video,sensor:time},decision,action});
    applied++;
  }
  return {batch,report:{applied,kept,issues,remaining:batch.results.reduce((n,r)=>n+(r.differences?.length??0),0)}};
}

function main(){
  const [research,input,output,...files]=process.argv.slice(2);
  if(!files.length)throw Error('用法：node tools/apply-video-review.js 原研究目录 深度标定结果.json 新标定结果.json 复核标记.json […]');
  const index=new Map(read(path.join(research,'记录索引.json')).records.map(r=>[r.original_id,r]));
  const app=loadPage('test.html');
  const cached=new Map();
  try{
    const result=applyMarks(read(input),files.map(read),row=>read(path.join(research,index.get(row.record_id).file)),(bundle,difference,row)=>{
      if(!cached.has(row.record_id)){
        const rows=bundle.original.sample_chunks.slice().sort((a,b)=>a.index-b.index).flatMap(c=>c.rows);
        const track=sensorTracks(bundle);
        const trials=trialEvents(app.app,bundle.original,rows,bundle.reanalysis.events.filter(e=>e.source==='isolated-review'));
        cached.set(row.record_id,{track,trials});
      }
      const {track,trials}=cached.get(row.record_id);
      return trials.filter(e=>e.amp>=6&&Math.abs(e.ms-difference.sensor)<=100&&
        !row.calibrated_marks.some(ms=>Math.abs(ms-e.ms)<240)&&
        track.coverage.some(r=>r.from<=e.ms-120&&r.to>=e.ms+160))
        .sort((a,b)=>b.factor-a.factor||Math.abs(a.ms-difference.sensor)-Math.abs(b.ms-difference.sensor))[0]?.event;
    });
    if(!result.report.applied)throw Error('没有可应用的标记。 '+JSON.stringify(result.report));
    fs.writeFileSync(output,JSON.stringify({...result.batch,manual_review_report:result.report}),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({...result.report,issues:result.report.issues.length}));
  }finally{app.close();}
}

if(require.main===module)main();
module.exports={applyMarks};
