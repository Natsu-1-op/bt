// Build a self-contained local review page from the batch results and research records.
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {compare, sensorTracks} = require('../video-review');
const {matchVideos} = require('./review-video-batch');
const {loadPage} = require('../tests/helpers/page');

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));

function waveform(rows, start) {
  const step = 10;
  const low = [], high = [];
  for (const row of rows) {
    if (!Number.isFinite(row[4]) || (row[6]&14)) continue;
    const i = Math.floor((row[0]-start)/step);
    low[i] = Math.min(low[i]??Infinity,row[4]);
    high[i] = Math.max(high[i]??-Infinity,row[4]);
  }
  return {step,low,high};
}

function tryCalibration(app, record, rows, track, result) {
  const current = result.adaptive;
  if (!result.alignment?.reliable || !current?.video_only.length) return null;
  const {config, blink_calibration: calibration, detector} = record.metadata;
  const seed = calibration?.threshold ?? detector?.drop_counts ?? config.minDropCounts;
  // One preset across all recordings. Reuse the original formal start and baseline.
  const settings = {noiseMultiplier:config.noiseMultiplier*.8, minDropCounts:config.minDropCounts*.8};
  const detect = app.makeOfflineDetector({...config,...settings,manualThresholdEnabled:false,
    thresholdPolicy:'adaptive-bipolar-v3'},seed,calibration,true,true);
  const start = record.metadata.first_timeline_ms;
  const events = rows.map(detect).filter(Boolean).map(e=>({ms:e.t-start,amp:e.amp,threshold_counts:e.threshold_counts}));
  const video = {coverage:current.overlap,events:[...current.matched.map(m=>m.video),...current.video_only].sort((a,b)=>a.ms-b.ms)};
  const trial = compare({...track,events},video,result.alignment.offset);
  const paired = new Set(trial.matched.map(m=>m.video.ms));
  const recovered = current.video_only.filter(e=>paired.has(e.ms)).map(e=>e.ms);
  const lost = current.matched.filter(m=>!paired.has(m.video.ms)).length;
  const extra = trial.sensor_only.length-current.sensor_only.length;
  const newSensorOnly = trial.sensor_only.filter(e=>!current.sensor_only.some(previous=>Math.abs(previous.ms-e.ms)<=200))
    .map(e=>({sensor:e.ms,video:e.video_ms,type:'试算新增仅传感器'}));
  return {settings,before:{noiseMultiplier:config.noiseMultiplier,minDropCounts:config.minDropCounts},
    events:trial.matched.map(m=>m.sensor.ms).concat(trial.sensor_only.map(e=>e.ms)).sort((a,b)=>a-b),
    matched:trial.matched.length, videoOnly:trial.video_only.length, sensorOnly:trial.sensor_only.length, recovered,newSensorOnly,
    suggested:recovered.length>lost+Math.max(0,extra) && trial.matched.length>current.matched.length};
}

function build(researchDir,videoDir,batchFile,out) {
  const index = read(path.join(researchDir,'记录索引.json'));
  const batch = read(batchFile);
  const calibrated=batch.schema==='blink-video-calibrated/v1';
  if (!calibrated&&batch.schema!=='blink-video-batch/v1') throw Error('请选择 MediaPipe 复核或双端标定结果');
  const app = loadPage('test.html');
  const cases = [];
  try {
    const availableVideos=fs.existsSync(videoDir)?fs.readdirSync(videoDir):[];
    const results=new Map(batch.results.map(r=>[r.subject,r]));
    for (const {subject,file} of index.records) {
      const result=results.get(subject)??{subject,status:'待配对视频',reason:'没有找到对应录像'};
      const bundle=read(path.join(researchDir,file));
      const record=bundle.original??bundle;
      const rows=record.sample_chunks.slice().sort((a,b)=>a.index-b.index).flatMap(c=>c.rows);
      let track;
      try { track=sensorTracks(bundle); }
      catch { track={record_id:record.metadata.id,first_utc_ms:rows[0][1],events:[],reanalysis:null}; }
      const preferred=result.adaptive??result.original;
      const offset=result.alignment?.offset;
      const videoFile=result.video_file??(calibrated?null:matchVideos([{subject:result.subject,track}],availableVideos)[0].file);
      const differences=calibrated ? (result.differences??[]) : preferred ? [
        ...preferred.video_only.map(e=>({video:e.ms,sensor:e.ms-offset,type:'仅视频'})),
        ...preferred.sensor_only.map(e=>({video:e.video_ms,sensor:e.ms,type:'仅传感器'}))
      ].sort((a,b)=>a.video-b.video) : [];
      const trial=!calibrated&&track.coverage?tryCalibration(app.app,record,rows,track,result):null;
      cases.push({id:track.record_id,subject:result.subject,status:result.status,reason:result.reason,videoFile,
        videoUrl:videoFile?pathToFileURL(path.join(videoDir,videoFile)).href:null, offset, aligned:result.alignment?.reliable===true,
        duration:rows.at(-1)[0]-rows[0][0], utc:track.first_utc_ms,
        differences, original:track.events.map(e=>e.ms), adaptive:result.calibrated_marks??(track.reanalysis??[]).filter(e=>e.source==='adaptive').map(e=>e.ms),
        candidates:result.candidate_marks??[], alignedCoverage:result.overlap_ms, reviewRegions:result.review_regions??[],
        automatic:calibrated?{added:result.accepted?.length??0,removed:result.rejected?.length??0,
          confirmed:result.confirmed?.length??0,videoOnly:result.video_only_confirmed?.length??0,
          reviewed:result.deep_review?.length??0}:null,
        waveform:waveform(rows,rows[0][0]), trial});
    }
  } finally { app.close(); }
  const template=fs.readFileSync(path.join(__dirname,'video-review-workbench.html'),'utf8');
  const serialized=JSON.stringify(cases).replaceAll('<','\\u003c');
  const temp=out+'.tmp';
  fs.writeFileSync(temp,template.replace('<!-- REVIEW_DATA -->',()=>`<script id="cases" type="application/json">${serialized}</script>`),{mode:0o600});
  fs.renameSync(temp,out);
  return {cases:cases.length, differences:cases.reduce((sum,r)=>sum+r.differences.length,0),
    suggestions:cases.filter(r=>r.trial?.suggested).map(r=>({subject:r.subject,recovered:r.trial.recovered.length,matched:r.trial.matched,videoOnly:r.trial.videoOnly,sensorOnly:r.trial.sensorOnly}))};
}

if(require.main===module){
  const [research,video,batch,out]=process.argv.slice(2);
  if(!out){console.error('用法：node tools/build-video-review.js 研究目录 视频目录 复核结果.json 输出.html');process.exit(1);}
  console.log(JSON.stringify(build(research,video,batch,out)));
}
module.exports={build};
