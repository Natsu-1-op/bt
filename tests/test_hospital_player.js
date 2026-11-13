const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {displaySession,beijing,selectHospitalSessions}=require('../tools/export-review-delivery');
const file=path.resolve(__dirname,'../hospital-player.html');
const html=fs.readFileSync(file,'utf8');
const session=(subject,created,ms,status='user_stop')=>({metadata:{participant_id:subject,created_utc_ms:created,status,
  config:{},detector:{calibrated_timeline_ms:3000},segments:[{start_timeline_ms:0,end_timeline_ms:ms}]}});
const old=session('1',1,300000), latest=session('1',2,336000,'interrupted_snapshot'), short=session('1',3,60000);
const second=session('2',1,305000);
assert.deepEqual(selectHospitalSessions([short,old,session('test',9,305000),second,latest]),[latest,second]);
const {window:w}=new JSDOM(html,{runScripts:'outside-only'});
try{
  w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({}, {get:()=>()=>{}});
  w.requestAnimationFrame=()=>{};
  const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const api=w.eval(code+'\n({validateDisplay,open(input){records=validateDisplay(input);selectRecord(0);},seek})');
  const rows=Array.from({length:401},(_,i)=>[i*5,1700000000000+i*5,0,1111+i,2000+i%20,1,0]);
  const b={metadata:{id:'private-original-id',config:{sampleRateHz:200},operator_id:'do-not-export'},
    events:[{type:'blink',timeline_ms:120,amplitude_counts:34}]};
  const rec=displaySession(b,rows,'R001','8');
  assert.equal(rec.segments[0].trace.length,51);
  assert.equal(rec.beijing_start,beijing(rows[0][1]));
  const payload={schema:'blink-display/v1',step_ms:40,records:[rec]};
  assert.equal(api.validateDisplay(payload).length,1);
  assert.throws(()=>api.validateDisplay({schema:'blink-export/v1',sample_chunks:[]}),/文件格式不匹配/);
  assert(!/只读|医院专用|研究原始|非原始 ADC/.test(html));
  const data=JSON.stringify(payload);
  for(const key of ['private-original-id','do-not-export','amplitude_counts','sample_chunks','adc_raw'])assert(!data.includes(key));
  assert(!html.includes('download=')&&!html.includes('fetch(')&&!html.includes('<script src='));
  api.open(payload);api.seek(120);
  assert.match(w.document.getElementById('clock').textContent,/1 个标记/);
}finally{w.close();}
console.log('PASS separate hospital page: display-only data, waveform/seek, original file rejected');
