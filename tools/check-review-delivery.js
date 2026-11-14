const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validRegion,dynamicIntervals} = require('./review-quality');

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const researchName='研究用_含原始数据_勿外发';
const hospitalName='眨眼记录回放';
const recordKeys=['beijing_start','duration_ms','incomplete','marks','record','review_marks','segments','subject'];
const segmentKeys=['beijing_start','end_ms','start_ms','trace'];

function checkDelivery(directory, referenceDirectory){
  const research=path.join(directory,researchName);
  const playback=path.join(directory,hospitalName);
  const allowedFiles=new Set(['.DS_Store','使用说明.txt','播放数据.json','hp.html','眨眼记录播放器.html']);
  for(const entry of fs.readdirSync(playback,{withFileTypes:true}))
    assert(entry.isFile()&&allowedFiles.has(entry.name),`医院目录含未预期的文件 ${entry.name}`);

  const data=read(path.join(playback,'播放数据.json'));
  const index=read(path.join(research,'记录索引.json'));
  assert.equal(data.schema,'blink-display/v2');
  assert.equal(data.step_ms,20);
  assert.equal(index.records.length,data.records.length);
  const byId=new Map(data.records.map(record=>[record.record,record]));
  assert.equal(byId.size,data.records.length,'医院文件中有重复记录');
  assert.equal(new Set(index.records.map(row=>row.record)).size,index.records.length,'研究索引有重复记录');
  assert.equal(new Set(index.records.map(row=>row.subject)).size,index.records.length,'研究索引有重复受试者');
  let marks=0, pending=0;
  for(const row of index.records){
    const view=byId.get(row.record);
    const bundle=read(path.join(research,row.file));
    const original=bundle.original;
    const origin=original.metadata.first_timeline_ms;
    assert.equal(view?.subject,row.subject,`受试者 ${row.subject} 的两套记录未对应`);
    assert.equal(String(original.metadata.participant_id),row.subject);
    assert.equal(original.metadata.id,row.original_id);
    assert.equal(original.sample_chunks.reduce((n,chunk)=>n+chunk.rows.length,0),row.samples);
    assert.deepEqual(Object.keys(view).filter(k=>k!=='dynamic_error_intervals').sort(),recordKeys,`受试者 ${row.subject} 的医院文件有额外字段`);
    const regions=bundle.video_calibration?.review_regions??[];
    assert(regions.every(region=>validRegion(region,view.duration_ms)),`受试者 ${row.subject} 的复核区间无效`);
    assert.deepEqual(view.dynamic_error_intervals??[],dynamicIntervals(regions),`受试者 ${row.subject} 的动态误差区间不一致`);
    assert.equal(view.duration_ms,Math.round(original.metadata.last_timeline_ms-origin));
    assert(Number.isFinite(Date.parse(view.beijing_start)));
    let previousEnd=-1;
    for(const segment of view.segments){
      assert.deepEqual(Object.keys(segment).sort(),segmentKeys);
      assert(segment.start_ms>=previousEnd&&segment.end_ms>=segment.start_ms&&segment.end_ms<=view.duration_ms,'波形分段时间无效');
      assert(segment.trace.length<=Math.floor((segment.end_ms-segment.start_ms)/data.step_ms)+2,'波形分段样本数无效');
      assert(segment.trace.every(v=>v===null||Number.isInteger(v)&&Math.abs(v)<=127),'波形显示值越界');
      previousEnd=segment.end_ms;
    }
    const expected=bundle.reanalysis.events.filter(e=>!e.source).map(e=>Math.round(e.t-origin));
    assert.deepEqual(view.marks,expected,`受试者 ${row.subject} 的医院标记与研究标记不一致`);
    assert(view.marks.every((t,i)=>t>=0&&t<=view.duration_ms&&(!i||t>view.marks[i-1])),`受试者 ${row.subject} 的标记时间无效`);
    assert(view.review_marks.every((t,i)=>t>=0&&t<=view.duration_ms&&(!i||t>=view.review_marks[i-1])),`受试者 ${row.subject} 的候选标记无效`);
    if(referenceDirectory){
      const prior=read(path.join(referenceDirectory,researchName,row.file));
      assert.deepEqual(original,prior.original,`受试者 ${row.subject} 的原始记录已改变`);
    }
    marks+=view.marks.length;
    pending+=bundle.video_calibration?.remaining?.length??0;
  }
  return {records:index.records.length,marks,pending};
}

if(require.main===module){
  const [directory,reference]=process.argv.slice(2);
  if(!directory)throw Error('用法：node tools/check-review-delivery.js 交付目录 [对照交付目录]');
  console.log(JSON.stringify(checkDelivery(directory,reference)));
}
module.exports={checkDelivery};
