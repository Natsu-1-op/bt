// Local read-only audit. Prints counts by session; does not rewrite exports.
const fs = require('node:fs');
const {loadPage} = require('../tests/helpers/page');
const file = process.argv[2];
if (!file) throw new Error('Usage: node tools/audit-blink-middle.js <blink-all.json>');
const input = JSON.parse(fs.readFileSync(file,'utf8'));
const page = loadPage('test.html');
try {
  const a = page.app;
  const records = a.validateImport(input);
  const totals = {records:records.length, eligibleRecords:0, segments:0, seconds:0, saved:0, legacy:0, adaptive:0, middleOnly:0};
  for (const b of records) {
    const m = b.metadata, rows = b.sample_chunks.slice().sort((x,y)=>x.index-y.index).flatMap(c=>c.rows);
    const formal = m.config.blinkCalEnabled ? m.blink_calibration?.end_timeline_ms : m.detector?.calibrated_timeline_ms;
    if (!Number.isFinite(formal) || m.status === 'interrupted_snapshot') continue;
    const runs = [];
    for (const row of rows) {
      if (row[0] <= formal || (row[6] & 8)) continue;
      let last = runs.at(-1);
      if (!last || last.at(-1)[5] !== row[5] ||
          row[0] - last.at(-1)[0] > 3 * 1000 / m.config.sampleRateHz) {
        last = []; runs.push(last);
      }
      last.push(row);
    }
    const windows = runs.flatMap(r => {
      const start = r[0][0], end = r.at(-1)[0], duration = end-start;
      return duration >= 60000 ? [{from:start+duration*.2,to:end-duration*.2}] : [];
    });
    if (!windows.length) continue;
    totals.eligibleRecords++;
    const startDrop = m.blink_calibration?.threshold ?? m.detector?.drop_counts;
    const run = adaptive => rows.map(a.makeOfflineDetector(m.config,startDrop,m.blink_calibration,adaptive)).filter(Boolean);
    const old = run(false), adaptive = run(true);
    const result = {id:m.id.slice(0,8),seconds:0,saved:0,legacy:0,adaptive:0,middleOnly:0};
    for (const {from,to} of windows) {
      // First 10s within the middle provide context; they aren't scored.
      const scoreStart = from+10000;
      const inWindow = (t,width=0) => t >= scoreStart && t+width <= to;
      const local = a.makeOfflineDetector({...m.config,calibrationMs:2000,calibrationSkipMs:0,manualThresholdEnabled:false},null,null,true);
      const middleOnly = rows.filter(row=>row[0]>=from && row[0]<=to).map(local).filter(Boolean);
      totals.segments++;
      result.seconds += (to-scoreStart)/1000;
      result.saved += b.events.filter(e=>e.type==='blink' && inWindow(e.timeline_ms,e.width_ms)).length;
      result.legacy += old.filter(e=>inWindow(e.t,e.width)).length;
      result.adaptive += adaptive.filter(e=>inWindow(e.t,e.width)).length;
      result.middleOnly += middleOnly.filter(e=>inWindow(e.t,e.width)).length;
    }
    for (const key of ['seconds','saved','legacy','adaptive','middleOnly']) totals[key]+=result[key];
    console.log(JSON.stringify({...result,seconds:Math.round(result.seconds)}));
  }
  console.log(JSON.stringify({...totals,seconds:Math.round(totals.seconds)}));
} finally { page.close(); }
