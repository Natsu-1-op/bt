const assert=require('node:assert/strict');
const {videoEvents,compare,sensorTracks,frameEar,beijingTimestamp,videoAlignment,cueAlignment}=require('../video-review');
const {alignOffset,matchVideos,summarize,reportPage}=require('../tools/review-video-batch');
const frames=[];
for(let t=0;t<=3600;t+=40){
  let ear=.30;
  if((t>=1000&&t<1120)||(t>=2500&&t<2620))ear=.14;
  if(t>=2520&&t<=2640)ear=null; // cannot infer a blink across an occlusion
  frames.push({ms:t,ear});
}
const video=videoEvents(frames);
assert.deepEqual(video.events,[{ms:1000,width_ms:120}]);
assert(video.coverage[0].from>0,'exclude the open-eye baseline warm-up');
assert(!video.coverage.some(r=>r.from<2520&&r.to>2640));
const sensor={coverage:[{from:0,to:2700}],events:[{ms:100},{ms:520},{ms:560},{ms:2120}]};
const res=compare(sensor,video,480,80);
assert.equal(res.matched.length,1);
assert.equal(res.sensor_only.length,1);
assert.equal(res.sensor_outside,2);
assert.equal(res.video_only.length,0);
const split=compare({coverage:[{from:0,to:100},{from:120,to:200}],events:[{ms:95}]},
  {coverage:[{from:0,to:200}],events:[{ms:130}]},0,100);
assert.equal(split.matched.length,0,'do not match across a missing segment');
const crowded=compare({coverage:[{from:0,to:2000}],events:[{ms:800},{ms:975}]},
  {coverage:[{from:0,to:2000}],events:[{ms:990}]},0,200);
assert.equal(crowded.matched[0].sensor.ms,975,'prefer the nearer blink when the number of pairs is unchanged');
assert.equal(crowded.sensor_only[0].ms,800);
assert.equal(frameEar(null,640,480),null);
assert.throws(()=>sensorTracks({schema:'blink-display/v1'}),/研究 JSON/);
const tr=sensorTracks({schema:'blink-export/v1',metadata:{id:'a',participant_id:'5',first_timeline_ms:105,last_timeline_ms:120,
  detector:{calibrated_timeline_ms:100},config:{sampleRateHz:200}},
  sample_chunks:[{index:0,rows:[[105,1,1,2000,2000,1,0],[110,6,6,2000,2000,1,2],[115,11,11,2000,2000,1,0],[120,16,16,2000,2000,1,0]]}],events:[]});
assert.deepEqual(tr.coverage,[{from:0,to:0,segment:1},{from:10,to:15,segment:1}]);
assert.equal(beijingTimestamp('2026-11-13T11:30:25.123'),Date.parse('2026-11-13T03:30:25.123Z'));
assert(Number.isNaN(beijingTimestamp('2026-02-30T11:30')));
const timed={first_utc_ms:Date.parse('2026-11-13T03:30:25Z'),coverage:[{from:3000,to:300000}]};
assert.deepEqual(videoAlignment(timed,'2026-11-13T11:30:40',5,120),
  {start:Date.parse('2026-11-13T03:30:35Z'),offset:-10000,from:0,to:120});
assert.deepEqual(videoAlignment(timed,'2026-11-13T11:30:10',0,100),
  {start:Date.parse('2026-11-13T03:30:10Z'),offset:15000,from:18,to:100});
assert.throws(()=>videoAlignment(timed,'2026-11-12T11:30:10',0,100),/没有重叠/);
const withCues={...timed,coverage:[{from:3000,to:250000,segment:1},{from:251000,to:300000,segment:2}],cues:[{ms:10000,segment:1},{ms:210000,segment:1}]};
const two=cueAlignment(withCues,12010,212210,320);
assert.equal(two.scale,1.001);
assert(Math.abs(two.offset-2000)<1e-8);
assert(Math.abs(two.to-252.25)<1e-8,'only apply a cue fit to its continuous capture segment');
assert.equal(compare({...withCues,events:[{ms:200000}]},{coverage:[{from:0,to:320000}],events:[{ms:202200}]},two.offset,50,two.scale).matched.length,1);
assert.throws(()=>cueAlignment({...withCues,cues:[withCues.cues[0],{ms:210000,segment:2}]},12010,212210,320),/同一连续采集段/);
const irregular=Array.from({length:90},(_,i)=>1800+i*2300+(i*i*87)%1200);
const track={first_utc_ms:Date.parse('2026-11-13T03:30:25.495Z'),events:irregular.map(ms=>({ms})),coverage:[{from:0,to:215000}]};
const shifted={events:irregular.map(ms=>({ms:ms+2110})),coverage:[{from:0,to:220000}]};
const fit=alignOffset(track,shifted,1495);
assert.equal(fit.offset,2110);
assert.equal(fit.reliable,true);
assert.equal(alignOffset(track,{...shifted,events:shifted.events.filter(e=>Math.floor(e.ms/30000)%2===0)},1495).reliable,false);
const [matched]=matchVideos([{subject:'17',track}],['VID20261113113024.mp4','VID20261113113036.mp4']);
assert.equal(matched.file,'VID20261113113024.mp4');
assert.equal(matched.ambiguous,true);
const [override]=matchVideos([{subject:'17',track}],['custom.mov'],{'17':{video:'custom.mov',offset_ms:2110}});
assert.equal(override.manual,2110);
assert.equal(override.error,null);
const duplicates=matchVideos([{subject:'17',track},{subject:'18',track}],['VID20261113113024.mp4']);
assert(duplicates.every(r=>r.error.includes('多条')));
assert.equal(summarize(matched,{model:'test',frames:[[0,.3]]}).status,'待对时');
assert.match(reportPage([{subject:'<17>',status:'有差异',video_file:'VID20261113113024.mp4',original:res}],'/local/video'),/&lt;17&gt;/);
console.log('PASS video EAR timing, occlusion, warm-up, and one-to-one matching');
