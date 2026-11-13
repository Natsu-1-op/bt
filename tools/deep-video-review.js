const fs = require('node:fs');
const path = require('node:path');
const {compare, sensorTracks, videoEvents} = require('../video-review');
const {fitOffset,loadFrames} = require('./fit-video-review');
const {write,trialEvents} = require('./calibrate-video-delivery');
const {loadPage} = require('../tests/helpers/page');

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const median = values => values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
const nearest = (events,at,radius) => events.filter(e=>Math.abs(e.ms-at)<=radius).sort((a,b)=>Math.abs(a.ms-at)-Math.abs(b.ms-at))[0];
const valid = frame => frame?.length===5&&frame.every(Number.isFinite);

function slice(frames,from,to){
  let lo=0,hi=frames.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(frames[mid][0]<from)lo=mid+1;else hi=mid;}
  const subset=[];
  while(lo<frames.length&&frames[lo][0]<=to)subset.push(frames[lo++]);
  return subset;
}

function evaluateEyeMotion(frames, at, side){
  const lo=at-(side==='仅视频'?95:210),hi=at+310;
  const center=slice(frames,lo,hi);
  const left=slice(frames,lo-370,lo-30).filter(valid),right=slice(frames,hi+30,hi+370).filter(valid);
  if(left.length<5||right.length<5||center.length<7)return {state:'coverage'};
  const leftBase=[1,2].map(i=>median(left.map(f=>f[i]))),rightBase=[1,2].map(i=>median(right.map(f=>f[i])));
  const baseline=leftBase.map((value,i)=>Math.min(value,rightBase[i]));
  const openScores=[3,4].map(i=>Math.max(median(left.map(f=>f[i])),median(right.map(f=>f[i]))));
  const stable=leftBase.every((a,i)=>baseline[i]>=.105&&Math.abs(a-rightBase[i])<=.22*Math.max(a,rightBase[i]));
  const measured=center.filter(valid);
  const maxGap=Math.max((measured[0]?.[0]??Infinity)-lo,hi-(measured.at(-1)?.[0]??-Infinity),
    ...measured.slice(1).map((f,i)=>f[0]-measured[i][0]));
  if(measured.length<7||maxGap>85)return {state:'coverage'};
  const series=measured.map(f=>({ms:f[0],depth:Math.min(1-f[1]/baseline[0],1-f[2]/baseline[1]),
    score:Math.min(f[3],f[4]),above:Math.min(f[3]-openScores[0],f[4]-openScores[1]),
    anyDepth:Math.max(1-f[1]/baseline[0],1-f[2]/baseline[1]),anyScore:Math.max(f[3],f[4])}));
  const peaks=series.filter((f,i)=>{
    if(f.depth<.23||f.score<.39||f.above<.20||Math.abs(f.ms-at)>220)return false;
    return [series[i-1],series[i+1]].some(n=>n&&Math.abs(n.ms-f.ms)<=62&&n.depth>=.12&&n.above>=.10);
  }).sort((a,b)=>b.score+b.depth-a.score-a.depth);
  if(peaks.length)return {state:'blink',peak:peaks[0]};
  if(!stable&&maxGap<=58&&baseline.every(v=>v>=.10)){
    const leftTime=median(left.map(f=>f[0])),rightTime=median(right.map(f=>f[0]));
    const lowScores=series.every(f=>f.anyScore<=Math.max(.32,...openScores)+.05);
    const steadyEachEye=[0,1].every(i=>{
      const ratio=rightBase[i]/leftBase[i];
      if(ratio<.57||ratio>1.75)return false;
      return measured.every(f=>{
        const share=(f[0]-leftTime)/(rightTime-leftTime);
        const expected=leftBase[i]+share*(rightBase[i]-leftBase[i]);
        return Math.abs(f[i+1]-expected)<=expected*.115;
      });
    });
    if(lowScores&&steadyEachEye)return {state:'open',basis:'linear-local-baseline'};
  }
  if(!stable)return {state:'unstable'};
  const steady=maxGap<=58&&series.every(f=>f.anyDepth<=.16&&f.anyScore<=Math.max(.32,...openScores)+.07);
  if(steady)return {state:'open'};
  return {state:'ambiguous'};
}

function scoreEvents(frames){
  // The minimum score requires a bilateral movement. Hysteresis rejects jitter.
  const series=frames.map(f=>({ms:f[0],ear:valid(f)?Math.max(.04,1-Math.min(f[3],f[4])):null}));
  return videoEvents(series,.55);
}

function scorePeaks(frames){
  const events=[];
  for(const f of frames){
    if(!valid(f)||Math.min(f[3],f[4])<.42)continue;
    const result=evaluateEyeMotion(frames,f[0],'仅传感器');
    if(result.state!=='blink'||result.peak.ms!==f[0])continue;
    const previous=events.at(-1);
    if(previous&&f[0]-previous.ms<220){
      if(previous.score<result.peak.score)events[events.length-1]={ms:f[0]-45,score:result.peak.score};
    }else events.push({ms:f[0]-45,score:result.peak.score});
  }
  return {events};
}

function anchorSupport(paired, videoMs){
  const usable=paired.matched.filter(m=>Math.abs(m.video.ms-videoMs)<40000&&Math.abs(m.delta_ms)<105);
  const before=usable.filter(m=>m.video.ms<videoMs),after=usable.filter(m=>m.video.ms>videoMs);
  if(usable.length>=3&&before.length&&after.length)return true;
  // Near either end of a record, allow a cluster of tight anchors on one side.
  return [before,after].some(group=>group.filter(m=>Math.abs(m.video.ms-videoMs)<17000&&Math.abs(m.delta_ms)<60).length>=4);
}

function tightlyFitsCandidate(events, video, nominal){
  if(!Number.isFinite(nominal))return {offset:null,matches:0,rival:0,video_events:video.events.length};
  const offsets=[];
  for(let correction=-8000;correction<=8000;correction+=25){
    const offset=nominal+correction;
    const matches=video.events.map(v=>nearest(events,v.ms-offset,95)).filter(Boolean);
    offsets.push({offset,matches:new Set(matches.map(e=>e.ms)).size});
  }
  offsets.sort((a,b)=>b.matches-a.matches||Math.abs(a.offset-nominal)-Math.abs(b.offset-nominal));
  const best=offsets[0];
  const rival=offsets.find(o=>Math.abs(o.offset-best.offset)>350);
  return {...best,rival:rival?.matches??0,video_events:video.events.length};
}

function adjudicate(previous,frames,track,bundle,app,video){
  const start=bundle.original.metadata.first_timeline_ms;
  const priorEvents=bundle.reanalysis.events;
  const primary=track.reanalysis.filter(e=>e.source==='adaptive');
  const paired=compare({...track,events:primary},video,previous.alignment.offset);
  const rows=bundle.original.sample_chunks.slice().sort((a,b)=>a.index-b.index).flatMap(c=>c.rows);
  const trials=trialEvents(app,bundle.original,rows,priorEvents.filter(e=>e.source==='isolated-review'));
  const next={...previous,accepted:previous.accepted.slice(),rejected:previous.rejected.slice(),confirmed:previous.confirmed.slice(),
    video_only_confirmed:previous.video_only_confirmed.slice(),differences:[],deep_review:[]};
  const removed=new Set(next.rejected.map(e=>e.sensor_ms));
  const candidates=new Set(next.candidate_marks);
  const selected=new Map(next.calibrated_events.map(e=>[e.t-start,e]));
  for(const difference of previous.differences){
    const evidence=evaluateEyeMotion(frames,difference.video,difference.type);
    const context=anchorSupport(paired,difference.video);
    const outcome={...difference,video_evidence:evidence,nearby_alignment:context};
    const {sensor,video:at,type}=difference;
    const sensorEvent=priorEvents.find(e=>!e.source&&e.t-start===sensor);
    const videoPair=paired.matched.find(m=>m.video.ms===at);
    const sensorPair=paired.matched.find(m=>m.sensor.ms===sensor);
    const nearbyPair=paired.matched.find(m=>Math.abs(m.video.ms-(evidence.peak?.ms??at))<=190&&Math.abs(m.delta_ms)<=100);
    if(type==='仅传感器'&&sensorEvent&&!removed.has(sensor)&&(sensorPair&&Math.abs(sensorPair.delta_ms)<=100 || context&&evidence.state==='blink'&&
      !paired.matched.some(m=>Math.abs(m.video.ms-evidence.peak.ms)<=200))){
      selected.set(sensor,sensorEvent);candidates.delete(Math.round(sensor));
      next.confirmed.push({sensor_ms:sensor,video_ms:sensorPair?.video.ms??at,method:sensorPair?'nearest-pair':'bilateral-video'});
      outcome.decision='保留传感器事件';
    }else if(type==='仅传感器'&&sensorEvent&&context&&evidence.state==='open'&&!sensorPair){
      selected.delete(sensor);removed.add(sensor);candidates.delete(Math.round(sensor));
      next.rejected.push({sensor_ms:sensor,video_ms:at,method:'bilateral-open-eyes'});
      outcome.decision='排除传感器标记';
    }else if(type==='仅视频'&&videoPair&&Math.abs(videoPair.delta_ms)<=100&&!removed.has(videoPair.sensor.ms)){
      const event=priorEvents.find(e=>!e.source&&e.t-start===videoPair.sensor.ms);
      if(event){selected.set(videoPair.sensor.ms,event);candidates.delete(Math.round(videoPair.sensor.ms));}
      outcome.decision='已和传感器配对';
    }else if(context&&evidence.state==='blink'&&nearbyPair){
      if(type==='仅传感器'&&sensorEvent&&Math.abs(nearbyPair.sensor.ms-sensor)<=240){
        selected.delete(sensor);candidates.delete(Math.round(sensor));removed.add(sensor);
        next.rejected.push({sensor_ms:sensor,video_ms:at,method:'duplicate-near-paired-blink'});
        outcome.decision='排除重复传感器标记';
      }else if(type==='仅视频'&&Math.abs(nearbyPair.video.ms-at)<=190){
        outcome.decision='合并同次视频闭眼';
      }
    }else if(type==='仅视频'&&context&&evidence.state==='blink'){
      const response=nearest(trials.filter(e=>e.amp>=6 &&
        track.coverage.some(r=>r.from<=e.ms-120&&r.to>=e.ms+160)&&
        !nearest(primary,e.ms,240)&& ![...selected.keys()].some(t=>Math.abs(t-e.ms)<240)),sensor,85);
      if(response){
        const event={...response.event};delete event.source;
        selected.set(response.ms,event);candidates.delete(Math.round(response.ms));
        next.accepted.push({event,video_ms:at,threshold_factor:response.factor,method:'bilateral-video-and-sensor'});
        outcome.decision='补回传感器事件';
      }else{
        next.video_only_confirmed.push({video_ms:at,sensor_ms:sensor,method:'bilateral-video'});
        outcome.decision='确认仅视频';
      }
    }else if(type==='仅视频'&&context&&evidence.state==='open'){
      outcome.decision='排除视频误报';
    }
    if(!outcome.decision){
      outcome.decision='待人工确认';
      const reasons={coverage:'眼部关键点覆盖不足',unstable:'闭眼前后基线不稳定',ambiguous:'左右眼证据不一致或幅度不足'};
      next.differences.push({...difference,reason:context?(reasons[evidence.state]??difference.reason):'局部对时证据不足',
        prior_reason:difference.reason,
        priority:evidence.state==='blink',eye_peak:evidence.peak?.ms,
        eye_scores:slice(frames,at-700,at+700).map(f=>[f[0],f[3],f[4]])});
    }
    next.deep_review.push(outcome);
  }
  next.calibrated_events=[...selected].filter(([ms])=>!removed.has(ms)).map(([,e])=>e).sort((a,b)=>a.t-b.t);
  next.calibrated_marks=next.calibrated_events.map(e=>Math.round(e.t-start));
  next.candidate_marks=[...candidates].filter(ms=>!next.calibrated_marks.some(t=>Math.abs(t-ms)<=200)).sort((a,b)=>a-b);
  next.status=next.differences.length?'有待人工确认':'已校对';
  return next;
}

function main(){
  const [research,videoDir,out]=process.argv.slice(2);
  if(!out)throw Error('用法：node tools/deep-video-review.js 原研究目录 视频目录 复核目录');
  const previous=read(path.join(out,'双端标定结果.json'));
  const expected=new Set(read(path.join(out,'深度复核任务.json')).map(job=>job.subject));
  const alternateJobs=path.join(out,'辅助录像任务.json');
  const alternatives=fs.existsSync(alternateJobs)?read(alternateJobs):[];
  const evidenceDir=path.join(out,'.眼部证据');
  const names=fs.readdirSync(evidenceDir).filter(name=>name.endsWith('.json'));
  names.sort((a,b)=>fs.statSync(path.join(evidenceDir,a)).mtimeMs-fs.statSync(path.join(evidenceDir,b)).mtimeMs);
  const scans=new Map(names.map(name=>{
    const result=read(path.join(evidenceDir,name));return [result.subject,result.frames];
  }));
  const rows=new Map(read(path.join(research,'记录索引.json')).records.map(r=>[r.subject,r]));
  const app=loadPage('test.html');
  const target=path.join(out,'深度标定结果.json');
  const results=[];
  try{
    for(const prior of previous.results){
      const frames=scans.get(prior.subject);
      const row=rows.get(prior.subject);
      const result=frames&&prior.alignment?.reliable&&prior.differences.length
        ? (()=>{
          const bundle=read(path.join(research,row.file));
          const videoFrames=loadFrames(path.join(out,'.cache'),path.join(videoDir,prior.video_file));
          return adjudicate(prior,frames,sensorTracks(bundle),bundle,app.app,videoEvents(videoFrames));
        })() : prior;
      if(frames&&!prior.alignment?.reliable){
        const track=sensorTracks(read(path.join(research,row.file)));
        const full={...track,events:track.reanalysis};
        result.deep_alignment={score:fitOffset(full,scoreEvents(frames),prior.nominal_offset_ms),
          bilateral:fitOffset(full,scorePeaks(frames),prior.nominal_offset_ms)};
      }
      const alternate=alternatives.find(job=>job.record_subject===prior.subject||job.subject===prior.subject+'-alternate');
      if(alternate){
        const candidateDir=path.join(out,'.候选录像证据');
        const file=fs.existsSync(candidateDir)&&fs.readdirSync(candidateDir).find(name=>name.startsWith(alternate.subject+'-'));
        if(file){
          const track=sensorTracks(read(path.join(research,row.file)));
          const frames=read(path.join(candidateDir,file)).frames;
          const name=path.basename(alternate.file);
          const timestamp=/^VID(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\./i.exec(name);
          const [,y,mo,d,h,m,s]=timestamp??[];
          const nominal=track.first_utc_ms-Date.parse(`${y}-${mo}-${d}T${h}:${m}:${s}+08:00`);
          const fit=tightlyFitsCandidate(track.reanalysis,scorePeaks(frames),nominal);
          result.alternate_video={file:name,nominal_offset_ms:nominal,...fit};
          if(Number.isFinite(nominal)&&nominal+track.coverage.at(-1).to<0)
            result.reason='原录像没有眼部画面，另一段含人脸的录像与采集时间不重叠';
        }
      }
      results.push(result);
      write(target,{schema:previous.schema,complete:false,results});
      if(result.deep_review)console.log(prior.subject,result.deep_review.length-result.differences.length,result.differences.length);
    }
    const complete=[...expected].every(subject=>scans.has(subject)) &&
      previous.results.every(r=>!r.differences?.length||scans.has(r.subject));
    write(target,{schema:previous.schema,complete,results});
  }finally{app.close();}
}

if(require.main===module)main();
module.exports={evaluateEyeMotion};
