// Local-only: original/reanalysis and hospital display data never share a package.
const fs = require('node:fs');
const path = require('node:path');
const {loadPage} = require('../tests/helpers/page');
const beijing = ms => new Date(ms+28800000).toISOString().replace('Z','+08:00');
const safe = s => String(s).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,40) || 'unassigned';
const subjectOf = m=>String(m.participant_id || '未编号').trim();

function selectHospitalSessions(sessions){
  const selected=new Map();
  for(const b of sessions){
    const m=b.metadata,subject=subjectOf(m);
    if(!/^\d{1,4}$/.test(subject) || !['user_stop','interrupted_snapshot','max_duration'].includes(m.status) ||
      m.quality?.calibration_valid===false || m.storage_error)continue;
    const formal=m.config.blinkCalEnabled?m.blink_calibration?.end_timeline_ms:m.detector?.calibrated_timeline_ms;
    if(!Number.isFinite(formal))continue;
    // Prefer the last real run, not a short later reconnect or trial.
    const validMs=(m.segments||[]).reduce((ms,s)=>ms+Math.max(0,s.end_timeline_ms-Math.max(formal,s.start_timeline_ms)),0);
    if(validMs<240000)continue;
    if(!selected.has(subject)||m.created_utc_ms>=selected.get(subject).metadata.created_utc_ms)selected.set(subject,b);
  }
  return [...selected.values()].sort((a,b)=>Number(subjectOf(a.metadata))-Number(subjectOf(b.metadata)));
}

function displaySession(b, rows, ref, subject, analysis) {
  const m=b.metadata, origin=rows[0][0], elapsed=t=>Math.round(t-origin);
  const runs=[];
  for(const row of rows){
    let run=runs.at(-1);
    if(!run || run.id!==row[5] || row[0]-run.last>3*1000/m.config.sampleRateHz){
      run={id:row[5],first:row[0],last:row[0],utc:row[1],sums:[],counts:[]};runs.push(run);
    }
    run.last=row[0];
    // 50 Hz display averages of the processed trace; no raw samples or scale.
    const i=Math.floor((row[0]-run.first)/20);
    run.sums[i]=(run.sums[i]||0)+row[4];run.counts[i]=(run.counts[i]||0)+1;
  }
  const segments=runs.map(run=>{
    const means=run.sums.map((sum,i)=>sum/run.counts[i]);
    const sorted=means.filter(Number.isFinite).sort((a,b)=>a-b);
    const center=sorted[Math.floor(sorted.length/2)], span=Math.max(4,
      Math.abs(sorted[Math.floor(sorted.length*.02)]-center),Math.abs(sorted[Math.floor(sorted.length*.98)]-center));
    return {start_ms:elapsed(run.first),end_ms:elapsed(run.last),beijing_start:beijing(run.utc),
      trace:Array.from(means,v=>Number.isFinite(v)?Math.round(Math.max(-127,Math.min(127,48*Math.asinh((v-center)/span)))):null)};
  });
  const times=events=>events.map(e=>elapsed(e.t ?? e.timeline_ms)).sort((a,b)=>a-b);
  return {record:ref, subject, beijing_start:beijing(rows[0][1]),duration_ms:elapsed(rows.at(-1)[0]),
    incomplete:m.status==='interrupted_snapshot', segments,
    marks:times(analysis?.primary ?? b.events.filter(e=>e.type==='blink')),
    review_marks:times(analysis?.recovered ?? [])};
}

function deliver(inputPath,out,assignments = new Map()) {
  const data=JSON.parse(fs.readFileSync(inputPath,'utf8'));
  if(data.schema!=='blink-export-all/v1' || !Array.isArray(data.sessions))throw new Error('Expected a multi-session export');
  const p=loadPage('test.html');
  try {
    const a=p.app;
    for(const b of data.sessions)a.validateImport(b);
    for(const b of data.sessions)if(!b.metadata.participant_id && assignments.has(b.metadata.id)){
      b.metadata.participant_id=assignments.get(b.metadata.id);
    }
    fs.mkdirSync(out,{mode:0o700});
    const research=path.join(out,'研究用_含原始数据_勿外发'), hospital=path.join(out,'眨眼记录回放');
    fs.mkdirSync(research,{mode:0o700});fs.mkdirSync(hospital,{mode:0o700});
    const save=(file,content)=>fs.writeFileSync(file,typeof content==='string'?content:JSON.stringify(content),{flag:'wx',mode:0o600});
    const manifest=[], view=[];
    const hospitalRuns=new Set(selectHospitalSessions(data.sessions));
    for(const [i,b] of data.sessions.entries()){
      if(!hospitalRuns.has(b))continue;
      const m=b.metadata, rows=b.sample_chunks.slice().sort((a,b)=>a.index-b.index).flatMap(c=>c.rows);
      const subject=subjectOf(m);
      const original={...b,metadata:{...m,participant_id:subject,
        presentation_timezone:'Asia/Shanghai',created_beijing_iso:beijing(m.created_utc_ms),
        first_beijing_iso:beijing(rows[0][1]),last_beijing_iso:beijing(rows.at(-1)[1])},
        events:b.events.map(e=>({...e,beijing_iso:beijing(e.utc_ms)}))};
      delete original.metadata.reanalysis;
      const seed=m.blink_calibration?.threshold ?? m.detector?.drop_counts ?? m.config.minDropCounts;
      const formal=m.config.blinkCalEnabled ? m.blink_calibration?.end_timeline_ms : m.detector?.calibrated_timeline_ms;
      const config={...m.config,manualThresholdEnabled:false};
      const usable=Number.isFinite(formal) && m.quality?.calibration_valid!==false;
      const primary=usable?rows.map(a.makeOfflineDetector({...config,thresholdPolicy:'adaptive-bipolar-v3'},
        seed,m.blink_calibration,true,true)).filter(Boolean):[];
      const recovered=usable?a.reviewIsolatedBlinks(rows,config,primary,formal):[];
      const events=[...primary,...recovered].sort((a,b)=>a.t-b.t).map(e=>({...e,beijing_iso:beijing(e.utcMs)}));
      const output={schema:'blink-analysis/v1',original,reanalysis:{algorithm:'replay-isolated-review/v2',config,
        drop_counts:seed,calibration_policy:'reuse-original-calibration-boundary-and-baseline',
        computed_utc_ms:Date.now(),events,usable}};
      a.validateImport(output);
      const start=beijing(m.created_utc_ms),date=start.slice(0,10);
      const dir=path.join(research,date,'受试者_'+safe(subject));
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const ref='R'+String(i+1).padStart(3,'0');
      const name=start.slice(11,19).replaceAll(':','-')+'_'+ref+'.json';
      save(path.join(dir,name),output);
      manifest.push({record:ref,subject,original_id:m.id,beijing_start:start,status:m.status,samples:rows.length,
        saved:b.events.filter(e=>e.type==='blink').length,adaptive:primary.length,isolated:recovered.length,
        valid_formal_start:usable,file:path.relative(research,path.join(dir,name))});
      view.push(displaySession(b,rows,ref,subject,{primary,recovered}));
    }
    save(path.join(research,'记录索引.json'),{records:manifest,source_records:data.sessions.length,source_export_skipped:data.skipped||[]});
    view.sort((a,b)=>Number(a.subject)-Number(b.subject));
    save(path.join(hospital,'播放数据.json'),{schema:'blink-display/v2',step_ms:20,records:view});
    fs.copyFileSync(path.resolve(__dirname,'../hp.html'),path.join(hospital,'hp.html'),fs.constants.COPYFILE_EXCL);
    save(path.join(hospital,'使用说明.txt'),'打开 hp.html，导入同目录的播放数据 JSON。选择一条记录后点击播放，或拖动进度条查看指定时刻。页面时间为北京时间。\n');
    console.log(JSON.stringify({out,privateRecords:manifest.length,hospitalRecords:view.length,
      byDate:manifest.reduce((s,r)=>(s[r.beijing_start.slice(0,10)]=(s[r.beijing_start.slice(0,10)]||0)+1,s),{})}));
  } finally {p.close();}
}
if(require.main===module){
  const [input,out,...overrides]=process.argv.slice(2);
  if(!input||!out)throw new Error('Usage: node tools/export-review-delivery.js input.json new-output-folder [record-id=subject ...]');
  const assignments=new Map(overrides.map(s=>{
    const m=/^([a-f0-9-]{36})=(\d{1,4})$/i.exec(s);
    if(!m)throw Error('Invalid assignment; expected record-id=subject');
    return [m[1],m[2]];
  }));
  deliver(input,out,assignments);
}
module.exports={displaySession,beijing,selectHospitalSessions,subjectOf};
