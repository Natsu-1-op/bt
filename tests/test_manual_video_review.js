const assert = require('node:assert/strict');
const {applyMarks} = require('../tools/apply-video-review');

const first=1000;
const sensorEvent={t:1500,utcMs:5000,width:70,amp:12,threshold_counts:8,polarity:'fall'};
const events=[{video:600,sensor:500,type:'仅传感器'},{video:1500,sensor:1400,type:'仅视频'},
  {video:2000,sensor:1900,type:'仅视频'},{video:3000,sensor:2900,type:'仅视频'}];
const row={subject:'17',record_id:'capture-a',video_file:'a.mp4',alignment:{reliable:true,offset:100},
  differences:events,calibrated_events:[],calibrated_marks:[],candidate_marks:[500],video_only_confirmed:[]};
const batch={schema:'blink-video-calibrated/v1',complete:true,results:[row]};
const original={original:{metadata:{first_timeline_ms:first}},reanalysis:{events:[sensorEvent]}};
const mark=(i,decision,override={})=>({record_id:row.record_id,subject:row.subject,video_file:row.video_file,
  video_ms:events[i].video,sensor_ms:events[i].sensor,offset_ms:100,type:events[i].type,decision,...override});
const file=(...marks)=>({schema:'blink-video-review-labels/v2',marks});
const response={...sensorEvent,t:2405};
const result=applyMarks(batch,[file(mark(0,'是眨眼'),mark(1,'是眨眼'),mark(2,'是眨眼'),mark(3,'看不清'))],()=>original,
  (_bundle,difference)=>difference.sensor===1400?response:null);
assert.deepEqual(result.batch.results[0].calibrated_marks,[500,1405]);
assert.deepEqual(result.batch.results[0].candidate_marks,[]);
assert.deepEqual(result.batch.results[0].video_only_confirmed,[{sensor_ms:1900,video_ms:2000,method:'manual'}]);
assert.equal(result.report.applied,3);
assert.equal(result.report.kept,1);
assert.equal(result.report.remaining,1);
assert.deepEqual(row.calibrated_marks,[]);
assert.deepEqual(row.differences,events);

const conflicting=applyMarks(batch,[file(mark(0,'是眨眼')),file(mark(0,'非眨眼'),mark(1,'是眨眼',{offset_ms:101.5}))],()=>original,()=>response);
assert.equal(conflicting.report.applied,0);
assert.equal(conflicting.report.issues.length,2);
assert.equal(conflicting.report.remaining,4);
console.log('PASS manual review round-trip rules, conflicts and timing checks');
