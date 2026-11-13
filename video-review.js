(function(root){
  'use strict';
  const eyes=[[33,160,158,133,153,144],[362,385,387,263,373,380]];
  function frameEar(points,w,h){
    if(!points)return null;
    const ds=(a,b)=>Math.hypot((a.x-b.x)*w,(a.y-b.y)*h);
    const values=eyes.map(ids=>{
      const [a,b,c,d,e,f]=ids.map(i=>points[i]);
      if(![a,b,c,d,e,f].every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1))return NaN;
      const width=ds(a,d);
      return width>=10?(ds(b,f)+ds(c,e))/(2*width):NaN;
    });
    return values.every(x=>Number.isFinite(x)&&x>0&&x<0.8)?(values[0]+values[1])/2:null;
  }
  function beijingTimestamp(value){
    const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?$/.exec(value);
    if(!match)return NaN;
    const normalized=match[1]+'T'+match[2]+':'+(match[3]||'00')+'.'+(match[4]||'.0').slice(1).padEnd(3,'0');
    const utc=Date.parse(normalized+'+08:00');
    return Number.isFinite(utc)&&new Date(utc+28800000).toISOString().slice(0,23)===normalized?utc:NaN;
  }
  function videoAlignment(sensor, frameBeijing, frameSeconds, duration, from=0, to=duration){
    const anchor=beijingTimestamp(frameBeijing);
    if(!Number.isFinite(anchor)||!Number.isFinite(sensor.first_utc_ms)||!Number.isFinite(frameSeconds)||
      frameSeconds<0||frameSeconds>duration||!(from>=0&&to>from&&to<=duration))throw Error('请填写有效的北京时间、对应视频位置和分析区间。');
    const start=anchor-frameSeconds*1000;
    const offset=sensor.first_utc_ms-start;
    const intervals=sensor.coverage.map(r=>({from:Math.max(from*1000,r.from+offset),to:Math.min(to*1000,r.to+offset)})).filter(r=>r.to>r.from);
    if(!intervals.length)throw Error('视频和正式采集没有重叠，请核对日期、北京时间和对应帧。');
    return {start,offset,from:intervals[0].from/1000,to:intervals.at(-1).to/1000};
  }
  function videoEvents(frames,ratio=.70){
    const events=[],coverage=[],history=[];
    let closed=null,lastOpen=null,prev=null,last=-Infinity,run=null;
    for(const {ms,ear} of frames){
      if(!Number.isFinite(ear)||!prev||ms-prev.ms>70||ms<=prev.ms){
        closed=null;lastOpen=null;run=null;
        if(!Number.isFinite(ear)){prev=null;continue;}
      }
      prev={ms,ear};
      if(history.length<16){history.push(ear);continue;}
      const sorted=history.slice().sort((a,b)=>a-b),base=sorted[Math.floor((sorted.length-1)*.75)];
      if(!run && lastOpen!==null){run={from:lastOpen,to:ms};coverage.push(run);}
      if(run)run.to=ms;
      if(ear<=base*ratio){
        if(closed===null&&lastOpen!==null&&ms-last>=120)closed=ms;
      }else if(ear>=base*Math.min(.96,ratio+.12)){
        if(closed!==null&&ms-closed>=40&&ms-closed<=650){
          events.push({ms:closed,width_ms:ms-closed});last=ms;
        }
        closed=null;lastOpen=ms;history.push(ear);if(history.length>60)history.shift();
      }
    }
    return {events,coverage:coverage.filter(r=>r.to>r.from)};
  }
  // Monotone one-to-one matching. Compare only within shared, observed time.
  function compare(sensor, video, offset, tolerance=200){
    const overlap=[];
    for(const a of sensor.coverage)for(const b of video.coverage){
      const from=Math.max(a.from+offset,b.from),to=Math.min(a.to+offset,b.to);
      if(to>from)overlap.push({from,to});
    }
    const interval=t=>overlap.findIndex(r=>t>=r.from&&t<=r.to);
    const covered=t=>interval(t)>=0;
    const s=sensor.events.map(e=>({...e,video_ms:e.ms+offset})).filter(e=>covered(e.video_ms)).sort((a,b)=>a.video_ms-b.video_ms);
    const v=video.events.filter(e=>covered(e.ms)).sort((a,b)=>a.ms-b.ms);
    let i=0,j=0;const matches=[],sensorOnly=[],videoOnly=[];
    while(i<s.length&&j<v.length){
      const delta=s[i].video_ms-v[j].ms;
      if(delta< -tolerance)sensorOnly.push(s[i++]);
      else if(delta>tolerance)videoOnly.push(v[j++]);
      else if(interval(s[i].video_ms)!==interval(v[j].ms)){
        if(delta<0)sensorOnly.push(s[i++]);else videoOnly.push(v[j++]);
      }else matches.push({sensor:s[i++],video:v[j++],delta_ms:delta});
    }
    return {overlap,matched:matches,sensor_only:sensorOnly.concat(s.slice(i)),video_only:videoOnly.concat(v.slice(j)),
      sensor_outside:sensor.events.length-s.length,video_outside:video.events.length-v.length};
  }
  function sensorTracks(input){
    const original=input?.schema==='blink-analysis/v1'?input.original:input;
    const m=original?.metadata,t0=m?.first_timeline_ms;
    if(original?.schema!=='blink-export/v1'||!Number.isFinite(t0)||!Number.isFinite(m.last_timeline_ms)||
      !Array.isArray(original.events)||!Array.isArray(original.sample_chunks))
      throw Error('请选择逐条拆分的研究 JSON，不能导入整包或医院显示文件。');
    const formal=m.config?.blinkCalEnabled ? m.blink_calibration?.end_timeline_ms : m.detector?.calibrated_timeline_ms;
    if(!Number.isFinite(formal))throw Error('这条记录没有正式采集起点，不能做有效对照。');
    const coverage=[];
    // Use actual consecutive samples, not just session duration. Gaps and
    // flagged saturation never count as known observation time.
    let run=null,previous=null,firstUtc=null,clockOffset=null;
    const dt=1000/(m.config?.sampleRateHz||200);
    for(const c of [...(original.sample_chunks||[])].sort((a,b)=>a.index-b.index))for(const row of c.rows){
      const t=row[0];
      if(Number.isFinite(t)&&Number.isFinite(row[1])){
        if(firstUtc===null){
          if(t!==t0)throw Error('首采样与记录时间不一致，不能对齐。');
          firstUtc=row[1];clockOffset=row[1]-t;
        }
        if(Math.abs(row[1]-t-clockOffset)>200)
          throw Error('采集期间手机时钟有跳变，不能用单个时间偏移对齐；请按时钟变化点分段复核。');
      }
      if(!Number.isFinite(t)||t<=formal||(row[6]&14)){run=null;previous=null;continue;}
      if(!run||previous[5]!==row[5]||t-previous[0]>dt*1.6||t<=previous[0]){
        run={from:t-t0,to:t-t0};coverage.push(run);
      }
      run.to=t-t0;previous=row;
    }
    const events=original.events.filter(e=>e.type==='blink'&&Number.isFinite(e.timeline_ms))
      .map(e=>({ms:e.timeline_ms-t0,source:'original'}));
    const reanalysis=Array.isArray(input?.reanalysis?.events)?input.reanalysis.events.filter(e=>Number.isFinite(e.t))
      .map(e=>({ms:e.t-t0,source:e.source==='isolated-review'?'isolated-review':'adaptive'})):null;
    if(firstUtc===null||!coverage.some(r=>r.to>r.from))throw Error('没有足够的正式采样用于时间对照。');
    return {subject:String(m.participant_id||'未编号'),record_id:String(m.id),first_utc_ms:firstUtc,coverage,events,reanalysis};
  }
  if(typeof module==='object'&&module.exports)module.exports={frameEar,videoEvents,compare,sensorTracks,beijingTimestamp,videoAlignment};
  if(!root.document)return;
  const $=id=>root.document.getElementById(id),media=$('reviewMedia'),status=$('reviewStatus');
  if(!media)return;
  let url=null,video=null,sensor=null,report=null,busy=false,token=0,loadId=0;
  const message=t=>{status.textContent=t;};
  const clearReport=()=>{report=null;$('reviewSave').disabled=true;$('reviewResults').replaceChildren();};
  const setBusy=v=>{busy=v;for(const id of ['reviewVideo','reviewData','reviewScan','reviewFrom','reviewTo','reviewRatio','reviewStartTime','reviewAnchor','reviewUseTime'])$(id).disabled=v;$('reviewCancel').disabled=!v;};
  $('reviewVideo').onchange=()=>{
    const file=$('reviewVideo').files[0];if(!file)return;
    clearReport();video=null;if(url)URL.revokeObjectURL(url);
    $('reviewStartTime').value='';$('reviewAnchor').value='0';$('reviewFrom').value='';$('reviewTo').value='';
    url=URL.createObjectURL(file);media.src=url;
    message('正在读取本地视频…');
  };
  media.onloadedmetadata=()=>message('视频已打开，请填写对应帧的实际北京时间。');
  media.onerror=()=>message('浏览器无法解码此视频。可在本机转成 H.264 MP4 后重试。');
  $('reviewData').onchange=async()=>{
    const f=$('reviewData').files[0],id=++loadId;if(!f)return;
    sensor=null;clearReport();
    try{if(f.size>32*1024*1024)throw Error('请用逐条文件（最多32 MiB）。');
      const next=sensorTracks(JSON.parse(await f.text()));if(id!==loadId)return;
      sensor=next;message('已载入受试者 '+sensor.subject+'。采集首样本：'+
        new Date(sensor.first_utc_ms+28800000).toISOString().replace('T',' ').replace('Z','')+' 北京时间。');
    }catch(e){if(id===loadId)message(e.message);}
  };
  function seek(seconds){
    if(Math.abs(media.currentTime-seconds)<.001&&media.readyState>=2&&!media.seeking)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const clean=()=>{clearTimeout(timer);media.removeEventListener('seeked',done);media.removeEventListener('error',fail);};
      const done=()=>{clean();resolve();},fail=()=>{clean();reject(Error('视频定位失败。'));};
      const timer=setTimeout(fail,4000);
      media.addEventListener('seeked',done,{once:true});media.addEventListener('error',fail,{once:true});
      media.currentTime=seconds;
    });
  }
  $('reviewScan').onclick=async()=>{
    if(busy)return;
    const ratio=Number($('reviewRatio').value);
    if(typeof root.FaceMesh!=='function'){message('模型未加载，请检查网络。');return;}
    if(!sensor||!url||!Number.isFinite(media.duration)){message('请先选择可播放的视频和研究记录。');return;}
    let alignment;
    try{
      const end=$('reviewTo').value.trim();
      alignment=videoAlignment(sensor,$('reviewStartTime').value,Number($('reviewAnchor').value),media.duration,
        Number($('reviewFrom').value),end===''?media.duration:Number(end));
      if(alignment.to-alignment.from>900||!(ratio>=.4&&ratio<=.9))throw Error('单段最多分析15分钟；闭眼比例应为0.4～0.9。');
    }catch(e){message(e.message);return;}
    const {from,to}=alignment;
    const job=++token,frames=[];let mesh,lastEar=null;
    setBusy(true);clearReport();video=null;media.pause();media.controls=false;
    try{
      mesh=new root.FaceMesh({locateFile:f=>'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/'+f});
      mesh.setOptions({maxNumFaces:1,refineLandmarks:false,staticImageMode:true,minDetectionConfidence:.6});
      mesh.onResults(r=>{lastEar=frameEar(r.multiFaceLandmarks?.[0],media.videoWidth,media.videoHeight);});
      for(let i=0,ms=Math.round(from*1000);ms<to*1000&&job===token;i++,ms+=40){
        await seek(ms/1000);if(job!==token)break;
        lastEar=null;
        await mesh.send({image:media});
        if(job!==token)break;
        frames.push({ms:Math.round(media.currentTime*1000),ear:lastEar});
        if(i%25===0)message('分析中：'+(ms/1000).toFixed(1)+' / '+to.toFixed(1)+' 秒');
      }
      if(job!==token){message('已停止，未生成完整结果。');return;}
      video={...videoEvents(frames,ratio),from_ms:Math.round(from*1000),to_ms:Math.round(to*1000),ratio};
      renderComparison(alignment,frames.filter(f=>f.ear!==null).length,frames.length);
    }catch(e){message('分析失败：'+e.message);}
    finally{if(mesh)try{await mesh.close();}catch{}media.controls=true;setBusy(false);}
  };
  $('reviewCancel').onclick=()=>{token++;message('正在停止，等待当前帧完成…');};
  $('reviewUseTime').onclick=()=>{$('reviewAnchor').value=media.currentTime.toFixed(3);clearReport();};
  for(const id of ['reviewStartTime','reviewAnchor','reviewFrom','reviewTo','reviewRatio'])$(id).oninput=clearReport;
  function renderComparison(alignment,usableFrames,totalFrames){
    const {offset,start}=alignment;
    const original=compare(sensor,video,offset);
    if(!original.overlap.length){message('没有双方同时可用的时段，请检查视频区间和对齐值。');return;}
    const adaptive=sensor.reanalysis?compare({...sensor,events:sensor.reanalysis},video,offset):null;
    report={schema:'blink-video-comparison/v1',subject:sensor.subject,record_id:sensor.record_id,
      sensor_first_utc_ms:sensor.first_utc_ms,video_start_utc_ms:start,alignment_video_at_first_sample_ms:offset,tolerance_ms:200,
      video,original,adaptive,note:'视频及传感器事件均为候选，不等于人工真值。仅比较双方有观察的重叠时段。'};
    const box=$('reviewResults');
    const sec=n=>(n/1000).toFixed(3)+' 秒';
    for(const [label,r] of [['原始计数',original],['自适应＋补检',adaptive]]){
      if(!r)continue;
      const details=document.createElement('details');details.open=true;
      const title=document.createElement('summary');
      title.textContent=label+'：匹配 '+r.matched.length+' · 仅视频 '+r.video_only.length+' · 仅传感器 '+r.sensor_only.length;
      details.append(title);
      const rows=[...r.video_only.map(e=>['仅视频',e.ms]),...r.sensor_only.map(e=>['仅传感器',e.video_ms]),
        ...r.matched.map(e=>['匹配（偏差 '+Math.round(e.delta_ms)+'ms）',e.video.ms])].sort((a,b)=>a[1]-b[1]);
      for(const [label,ms] of rows){
        const button=document.createElement('button');button.type='button';button.textContent=sec(ms)+' · '+label;
        button.style.cssText='display:block;margin:5px 0;text-align:left';
        button.onclick=()=>{media.pause();media.currentTime=Math.max(0,ms/1000);};details.append(button);
      }
      box.append(details);
    }
    const seconds=original.overlap.reduce((n,r)=>n+r.to-r.from,0)/1000;
    message('受试者 '+sensor.subject+' · 可比 '+seconds.toFixed(1)+' 秒 · 可用帧 '+usableFrames+'/'+totalFrames+' · 匹配容差 ±200 ms。');
    $('reviewSave').disabled=false;
  }
  $('reviewSave').onclick=()=>{
    if(!report)return;
    const blobUrl=URL.createObjectURL(new Blob([JSON.stringify(report)],{type:'application/json'}));
    const a=document.createElement('a');a.href=blobUrl;a.download='blink-video-comparison.json';a.click();setTimeout(()=>URL.revokeObjectURL(blobUrl),1000);
  };
})(typeof window==='object'?window:globalThis);
