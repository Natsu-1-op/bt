// Local research workflow. Run with node, uv and access to the two input folders.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {pathToFileURL} = require('node:url');
const {beijingTimestamp, compare, sensorTracks, videoEvents} = require('../video-review');

const TOLERANCE_MS = 200;

function matchVideos(records, files, corrections = {}) {
  const candidates = files.flatMap(file => {
    const m = /^VID(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\.(mp4|mov)$/i.exec(file);
    return m ? [{file, utc:beijingTimestamp(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)}] : [];
  });
  const pairs = records.map(record => {
    if (record.error) return record;
    const correction = corrections[record.subject];
    const ranked = candidates.filter(v => Math.abs(record.track.first_utc_ms - v.utc) <= 60000)
      .sort((a,b) => Math.abs(record.track.first_utc_ms-a.utc)-Math.abs(record.track.first_utc_ms-b.utc));
    const file = correction?.video ?? ranked[0]?.file;
    const timestamp = candidates.find(v => v.file === file)?.utc;
    const nominal = record.track.first_utc_ms - timestamp;
    const alternate = ranked[1];
    const ambiguous = !correction?.video && alternate && Math.abs(record.track.first_utc_ms-alternate.utc)-Math.abs(nominal)<30_000;
    return {...record, file, nominal, manual:correction?.offset_ms, ambiguous:Boolean(ambiguous),
      alternatives:ranked.map(v=>v.file), error:files.includes(file)?null:'未找到候选视频'};
  });
  for (const row of pairs) if (row.file && pairs.some(other=>other!==row && other.file===row.file)) {
    row.error = '同一视频对应多条记录，请指定正确文件';
  }
  return pairs;
}

// The fitting and confirmation events come from disjoint time windows. Leave
// margins so an event near a window boundary cannot support both sets.
function alignOffset(track, video, nominal) {
  if (!Number.isFinite(nominal)) return null;
  const segment = ms => Math.floor(ms / 30000) % 2;
  const inner = ms => ms % 30000 >= 2000 && ms % 30000 < 28000;
  const anchors = (track.reanalysis?.filter(e=>e.source==='adaptive') ?? track.events).map(e=>e.ms).sort((a,b)=>a-b);
  const fit = video.events.filter(e=>inner(e.ms) && segment(e.ms)===0).map(e=>e.ms);
  const check = video.events.filter(e=>inner(e.ms) && segment(e.ms)===1).map(e=>e.ms);
  function pairing(times, offset, tolerance) {
    const residuals = [];
    let i=0;
    for (const ms of times) {
      while (i<anchors.length && anchors[i]+offset<ms-tolerance) i++;
      if (i===anchors.length || anchors[i]+offset>ms+tolerance) continue;
      while (i+1<anchors.length && Math.abs(anchors[i+1]+offset-ms)<Math.abs(anchors[i]+offset-ms)) i++;
      residuals.push(anchors[i++]+offset-ms);
    }
    return residuals;
  }
  const trials = [];
  for (let step=-8000;step<=8000;step+=20) {
    const offset=nominal+step;
    const score=pairing(fit,offset,160).reduce((n,d)=>n+1-Math.abs(d)/160,0);
    trials.push({offset,score});
  }
  trials.sort((a,b)=>b.score-a.score || Math.abs(a.offset-nominal)-Math.abs(b.offset-nominal));
  const best=trials[0], rival=trials.find(a=>Math.abs(a.offset-best.offset)>=400);
  const median = a => a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
  const correction=median(pairing(fit,best.offset,160));
  if (!Number.isFinite(correction)) return null;
  const offset=Math.round(best.offset-correction);
  const fitted=pairing(fit,offset,160), validated=pairing(check,offset,160);
  const medianError=median(validated.map(Math.abs));
  const reliable=fitted.length>=6 && validated.length>=6 && validated.length>=.30*check.length &&
    best.score>=Math.max(4,1.6*(rival?.score??0)) && medianError<=90;
  return {offset, reliable, fitted:fitted.length, validated:validated.length, available:check.length,
    median_error_ms:medianError??null};
}

function summarize(row, scanned) {
  const result={subject:row.subject, video_file:row.file, alternatives:row.alternatives??[], filename_ambiguous:row.ambiguous??false};
  if (row.error || scanned?.error || !scanned) return {...result,status:'待处理',reason:row.error??scanned?.error??'未完成视频扫描'};
  const frames=scanned.frames.map(([ms,ear])=>({ms,ear}));
  const video=videoEvents(frames);
  const alignment=Number.isFinite(row.manual) ? {offset:row.manual,reliable:true,manual:true} : alignOffset(row.track,video,row.nominal);
  const base={...result, model:scanned.model, video_duration_ms:frames.at(-1).ms, alignment};
  if (!alignment?.reliable) return {...base,status:'待对时',reason:row.ambiguous?'存在相近的候选视频，时间差未通过验证':'时间差未通过独立片段验证'};
  const {offset}=alignment;
  const original=compare(row.track,video,offset,TOLERANCE_MS);
  const recalculated=row.track.reanalysis?.filter(e=>e.source==='adaptive');
  const adaptive=recalculated ? compare({...row.track,events:recalculated},video,offset,TOLERANCE_MS) : null;
  const isolated=row.track.reanalysis ? compare({...row.track,events:row.track.reanalysis},video,offset,TOLERANCE_MS) : null;
  const covered=original.overlap.reduce((n,r)=>n+r.to-r.from,0);
  const formal=row.track.coverage.reduce((n,r)=>n+r.to-r.from,0);
  const primary=adaptive??original;
  const status=covered<formal*.8 ? '覆盖不足' : primary.video_only.length || primary.sensor_only.length ? '有差异' : '已对照';
  return {...base,status,covered_ms:covered,formal_ms:formal,original,adaptive,with_isolated:isolated,
    first_sample_utc_ms:row.track.first_utc_ms};
}

const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function reportPage(results, videoDir) {
  const counts = c => c ? `${c.matched.length} / ${c.video_only.length} / ${c.sensor_only.length}` : '—';
  const rows=results.map(r=>{
    const cmp=r.adaptive??r.original;
    const video=r.video_file ? pathToFileURL(path.join(videoDir,r.video_file)).href : '';
    const differences=cmp?[...cmp.video_only.map(e=>[e.ms,'仅视频']),...cmp.sensor_only.map(e=>[e.video_ms,'仅传感器'])].sort((a,b)=>a[0]-b[0]):[];
    const links=differences.map(([ms,label])=>`<a href="${escape(video)}#t=${(ms/1000).toFixed(3)}" target="_blank" rel="noopener">${(ms/1000).toFixed(3)} 秒 · ${label}</a>`).join('');
    const coverage=r.covered_ms===undefined?'—':`${(r.covered_ms/1000).toFixed(1)} / ${(r.formal_ms/1000).toFixed(1)} 秒`;
    const candidates=r.filename_ambiguous?`<details><summary>候选视频</summary>${r.alternatives.map(file=>`<a href="${escape(pathToFileURL(path.join(videoDir,file)).href)}" target="_blank" rel="noopener">${escape(file)}</a>`).join('')}</details>`:'';
    return `<tr><th scope="row">${escape(r.subject)}</th><td>${escape(r.status)}<br>${escape(r.reason)}${candidates}</td><td>${coverage}</td>`+
      `<td>${counts(r.original)}</td><td>${counts(r.adaptive)}</td><td>${counts(r.with_isolated)}</td><td>${r.alignment?(r.alignment.offset/1000).toFixed(3)+' 秒':'—'}</td>`+
      `<td>${video?`<a href="${escape(video)}" target="_blank" rel="noopener">打开视频</a>`:''}${links?`<details><summary>${differences.length} 处差异</summary>${links}</details>`:''}</td></tr>`;
  }).join('');
  const state=Object.entries(results.reduce((totals,r)=>{totals[r.status]=(totals[r.status]??0)+1;return totals;},{}))
    .map(([status,count])=>`${status} ${count}`).join(' · ');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MediaPipe 视频复核</title>`+
    `<style>body{margin:24px;font:15px system-ui;color:#e6eef8;background:#0a1422}table{border-collapse:collapse;min-width:760px;width:100%}th,td{padding:10px;border-bottom:1px solid #354b63;text-align:left;vertical-align:top}a{color:#9fd9ff}details a{display:block;margin:5px 0}.table{overflow:auto}</style>`+
    `<h1>MediaPipe 视频复核</h1><p>${results.length} 条 · ${escape(state)}</p><p>各列依次为配对次数、仅视频、仅传感器。差异链接跳到视频时间。视频参考为自动识别，配对容差 ±200 毫秒。</p>`+
    `<div class="table"><table><thead><tr><th>受试者</th><th>状态</th><th>可比 / 正式</th><th>原采集</th><th>自适应</th><th>含局部候选</th><th>首样本对应</th><th>定位</th></tr></thead><tbody>${rows}</tbody></table></div></html>`;
}

const json = file => JSON.parse(fs.readFileSync(file,'utf8'));
async function main() {
  const [researchDir, videoDir, out, correctionFile] = process.argv.slice(2).map(p=>path.resolve(p));
  if (!out) throw Error('用法：node tools/review-video-batch.js 研究用目录 视频目录 输出目录 [对时修正.json]');
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  const index=json(path.join(researchDir,'记录索引.json'));
  const records=index.records.map(({subject,file})=>{
    try{return {subject,track:sensorTracks(json(path.join(researchDir,file)))};}
    catch(error){return {subject,error:error.message};}
  });
  const rows=matchVideos(records,fs.readdirSync(videoDir),correctionFile?json(correctionFile):{});
  const active=rows.filter(r=>!r.error);
  const jobs=path.join(out,'scan-jobs.json');
  fs.writeFileSync(jobs,JSON.stringify({videos:active.map(r=>path.join(videoDir,r.file))}),{mode:0o600});
  const cache=path.join(out,'.cache');
  const args=['run','--script',path.join(__dirname,'mediapipe-video.py'),jobs,cache];
  if (process.env.BLINK_VIDEO_WORKERS) args.push('--workers',process.env.BLINK_VIDEO_WORKERS);
  const child=spawn('uv',args,{stdio:['ignore','pipe','inherit']});
  const exit=new Promise(resolve=>{child.once('error',resolve);child.once('close',code=>resolve(code));});
  const results=new Map();
  function save(progress) {
    const ordered=rows.map(row=>results.get(row)??(progress&&!row.error ? {subject:row.subject,status:'等待扫描'} : summarize(row)))
      .sort((a,b)=>Number(a.subject)-Number(b.subject));
    fs.writeFileSync(path.join(out,'复核汇总.html'),reportPage(ordered,videoDir),{mode:0o600});
    fs.writeFileSync(path.join(out,'复核结果.json'),JSON.stringify({schema:'blink-video-batch/v1',results:ordered}),{mode:0o600});
  }
  save(true);
  for await (const line of createInterface({input:child.stdout})) {
    const {index,cache,error}=JSON.parse(line);
    const row=active[index];
    results.set(row,summarize(row,error?{error}:json(cache)));
    console.log(`${results.size}/${active.length} · ${row.subject}号 · ${results.get(row).status}`);
    save(true);
  }
  save(false);
  const code=await exit;
  if (code!==0) throw Error('MediaPipe 扫描未完整结束，已保留本次可用结果。'+(code instanceof Error?' '+code.message:''));
}

if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={alignOffset,matchVideos,summarize,reportPage};
