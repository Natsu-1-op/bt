const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {compare, videoEvents} = require('../video-review');

const median = values => values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
const duration = intervals => intervals.reduce((n,r)=>n+r.to-r.from,0);
const nearest = (events, ms, radius) => events.reduce((best,e)=>Math.abs(e.ms-ms)<=radius &&
  (!best || Math.abs(e.ms-ms)<Math.abs(best.ms-ms)) ? e : best,null);
const inCoverage = (intervals, from, to=from) => intervals.some(r=>r.from<=from && r.to>=to);

function loadFrames(cache, file) {
  if (!file) return null;
  const stat=fs.statSync(file,{bigint:true});
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const implementation=sha(fs.readFileSync(path.join(__dirname,'mediapipe-video.py')));
  // Match the cache key from the existing Python scanner.
  const pathname=`PosixPath(${JSON.stringify(file).replace(/^"|"$/g,"'")})`;
  const name=sha(`(${pathname}, ${stat.size}, ${stat.mtimeNs}, '${implementation}')`)+'.json';
  const input=path.join(cache,name);
  if (!fs.existsSync(input)) return null;
  return JSON.parse(fs.readFileSync(input,'utf8')).frames.map(([ms,ear])=>({ms,ear}));
}

function fitOffset(track, video, nominal) {
  if (!Number.isFinite(nominal)) return null;
  const events=track.events.slice().sort((a,b)=>a.ms-b.ms);
  const groups=[[],[]];
  for (const event of video.events) {
    if(event.ms%30000>=2000&&event.ms%30000<28000)groups[Math.floor(event.ms/30000)%2].push(event);
  }
  function pair(group,offset,radius=130) {
    let i=0;
    const matches=[];
    for(const v of group){
      while(i<events.length&&events[i].ms+offset<v.ms-radius)i++;
      if(i===events.length||events[i].ms+offset>v.ms+radius)continue;
      while(i+1<events.length&&Math.abs(events[i+1].ms+offset-v.ms)<Math.abs(events[i].ms+offset-v.ms))i++;
      const s=events[i++];
      matches.push({video:v,sensor:s,delta:s.ms+offset-v.ms});
    }
    return matches;
  }
  function fit(group){
    const scores=[];
    for(let correction=-8000;correction<=8000;correction+=20){
      const offset=nominal+correction;
      const score=pair(group,offset).reduce((n,m)=>n+1-Math.abs(m.delta)/130,0);
      scores.push({offset,score});
    }
    scores.sort((a,b)=>b.score-a.score||Math.abs(a.offset-nominal)-Math.abs(b.offset-nominal));
    const best=scores[0],rival=scores.find(x=>Math.abs(x.offset-best.offset)>=400);
    const residual=median(pair(group,best.offset).map(m=>m.delta));
    return {offset:Math.round(best.offset-residual), score:best.score,rival:rival?.score??0};
  }
  const [a,b]=groups.map(fit);
  if(!Number.isFinite(a.offset)||!Number.isFinite(b.offset))return null;
  const offset=Math.round((a.offset+b.offset)/2);
  const matches=groups.map(group=>pair(group,offset));
  const residuals=matches.flat();
  const windows=new Set(residuals.map(m=>Math.floor(m.video.ms/30000)));
  const span=residuals.length?Math.max(...residuals.map(m=>m.video.ms))-Math.min(...residuals.map(m=>m.video.ms)):0;
  const reliable=Math.abs(a.offset-b.offset)<=85 && matches.every(m=>m.length>=4) && residuals.length>=10 &&
    windows.size>=4 && span>=90000 && [a,b].every(x=>x.score>=3&&x.score>=1.5*x.rival) &&
    median(residuals.map(m=>Math.abs(m.delta)))<=55;
  return {offset,reliable,halfOffsets:[a.offset,b.offset],matches:matches.map(m=>m.length),
    score:Math.min(a.score,b.score),peaks:[a,b],span_ms:span};
}

function chooseAlignment(track, signals, nominal) {
  const primary = {...track,events:track.reanalysis.filter(e=>e.source==='adaptive')};
  const full = {...track,events:track.reanalysis};
  const a = fitOffset(primary,signals.stable,nominal);
  const b = fitOffset(full,signals.stable,nominal);
  if(a?.reliable && (!b?.reliable||Math.abs(a.offset-b.offset)<=85))return {...a,anchor:'primary'};
  if(b?.reliable && (!a?.reliable||Math.abs(a.offset-b.offset)<=85))return {...b,anchor:'primary-and-isolated'};
  const c = fitOffset(full,signals.strict,nominal);
  if(b && c && Math.abs(b.offset-c.offset)<=65 &&
    [b,c].every(f=>Math.abs(f.halfOffsets[0]-f.halfOffsets[1])<=85 && f.matches.every(n=>n>=3) &&
      f.matches[0]+f.matches[1]>=10 && f.span_ms>=150000 && f.peaks.every(p=>p.score>=2 && p.score>=1.25*p.rival))){
    return {...b,reliable:true,anchor:'cross-checked-eye-thresholds',alternate_offset_ms:c.offset};
  }
  return b?{...b,reliable:false,anchor:'unverified'}:null;
}

const videoSignals = frames => ({stable:videoEvents(frames,.70),strict:videoEvents(frames,.62)});

function eyeWindow(frames, at, before, after) {
  let lo=0,hi=frames.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(frames[mid].ms<at-before)lo=mid+1;else hi=mid;}
  const window=[];
  while(lo<frames.length&&frames[lo].ms<=at+after)window.push(frames[lo++]);
  if(!window.length||window.some((f,i)=>!Number.isFinite(f.ear)||(i&&f.ms-window[i-1].ms>60))||
    window[0].ms-(at-before)>50||at+after-window.at(-1).ms>50)return null;
  return window;
}

function nearbyAlignment(matches, time) {
  const close=matches.filter(m=>Math.abs(m.video.ms-time)<30000 && Math.abs(m.delta_ms)<=100);
  return close.length>=3 && close.some(m=>m.video.ms<time) && close.some(m=>m.video.ms>time);
}

function eyeMotion(frames, at, before, after) {
  const center=eyeWindow(frames,at,before,after);
  if(!center)return null;
  const left=(eyeWindow(frames,at-before-130,120,100)??[]).map(f=>f.ear);
  const right=(eyeWindow(frames,at+after+130,100,120)??[]).map(f=>f.ear);
  if(left.length<3||right.length<3)return null;
  const baseLeft=median(left),baseRight=median(right);
  if(!(Math.min(baseLeft,baseRight)>=.13) || Math.abs(baseLeft-baseRight)>.20*Math.max(baseLeft,baseRight))return null;
  const floor=Math.min(baseLeft,baseRight),peak=Math.max(baseLeft,baseRight);
  const min=Math.min(...center.map(f=>f.ear));
  return {drop:1-min/floor,open:1-min/peak,minimum_ms:center.find(f=>f.ear===min)?.ms};
}

function clearClosure(frames, at, motion, before, after) {
  if(!motion||motion.drop<.34||Math.abs(motion.minimum_ms-at)>175)return false;
  const window=eyeWindow(frames,at,before,after);
  const minimum=window?.findIndex(f=>f.ms===motion.minimum_ms)??-1;
  if(minimum<1 || minimum>=window.length-1)return false;
  const low=window[minimum].ear;
  const open=low/(1-motion.drop);
  return Math.min(window[minimum-1].ear,window[minimum+1].ear)<=open*.84;
}

function classify(track, frames, video, alignment, trials) {
  const {stable}=video;
  const offset=alignment.offset;
  const paired=compare(track,stable,offset,200);
  const differences=[];
  const accepted=[];
  const rejected=[];
  const confirmed=[];
  const videoOnlyConfirmed=[];
  for(const event of paired.video_only){
    const at=event.ms-offset;
    const motion=eyeMotion(frames,event.ms,100,event.width_ms+100);
    const clear=motion?.drop>=.32 && event.width_ms<=350;
    const eligible=trials.filter(e=>Math.abs(e.ms-at)<=(e.factor<.8?75:105) &&
      (e.factor>=.8 || (e.amp>=6 && motion?.drop>=.40)) && !nearest(track.events,e.ms,250) && !nearest(accepted,e.ms,250) &&
      inCoverage(track.coverage,e.ms-120,e.ms+160));
    const response=eligible.sort((a,b)=>b.factor-a.factor||Math.abs(a.ms-at)-Math.abs(b.ms-at))[0];
    const locallyAligned=nearbyAlignment(paired.matched,event.ms);
    if(clear && response && locallyAligned){
      accepted.push({...response,video_ms:event.ms,video_width_ms:event.width_ms,eye_drop:motion.drop});
    }else if(!response && locallyAligned && event.width_ms>=65 && event.width_ms<=300 &&
      clearClosure(frames,event.ms+60,motion,160,event.width_ms+100)){
      videoOnlyConfirmed.push({video_ms:event.ms,sensor_ms:at,eye_drop:motion.drop,video_width_ms:event.width_ms});
    }else{
      differences.push({video:event.ms,sensor:at,type:'仅视频',reason:clear?'视频闭眼明显，传感器响应或局部对时不足':'眼部幅度或覆盖不足'});
    }
  }
  for(const event of paired.sensor_only){
    const at=event.video_ms;
    const motion=eyeMotion(frames,at,240,360);
    const clearlyOpen=motion && motion.open<=.10 && !nearest(stable.events,at,350) && nearbyAlignment(paired.matched,at);
    if(clearlyOpen){
      rejected.push({sensor_ms:event.ms,video_ms:at,eye_drop:motion.open});
    }else if(clearClosure(frames,at,motion,240,360) && !nearest(stable.events,at,350) && nearbyAlignment(paired.matched,at)){
      confirmed.push({sensor_ms:event.ms,video_ms:at,video_minimum_ms:motion.minimum_ms,eye_drop:motion.drop});
    }else{
      differences.push({video:at,sensor:event.ms,type:'仅传感器',reason:motion?'视频可能有浅闭眼或局部对时不足':'眼部关键点覆盖不足'});
    }
  }
  return {paired,accepted,rejected,confirmed,videoOnlyConfirmed,differences:differences.sort((a,b)=>a.video-b.video),overlap_ms:duration(paired.overlap)};
}

module.exports={loadFrames,fitOffset,chooseAlignment,videoSignals,classify};
