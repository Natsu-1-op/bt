const { readPageSource, extractFunction } = require('./helpers/source');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const src = readPageSource(path.join(__dirname, '../index.html'));
function extract(name) { return extractFunction(src, name); }
new Function(src.match(/<script>([^]*?)<\/script>/)[1]);
let now = 1000;
const gaps = [];
const S = {dev: {lastMcu: null, lastSeq: null, lastPage: null}};
const timeline = new Function('S', 'CFG', 'performance', 'breakSampleContinuity',
  extract('deviceTimeline') + '; return deviceTimeline;')(
  S, {sampleRateHz: 200}, {now: () => now}, (...args) => gaps.push(args));
let previous;
for (let i = 0; i <= 120000; i++) {
  now = 1000 + Math.floor(i / 16) * 80 + (i % 7) * 3;
  const t = timeline(i * 5, i);
  if (previous !== undefined) assert.equal(t - previous, 5);
  previous = t;
}
assert.equal(gaps.length, 0, '10 minutes must not resync');
assert.equal(timeline(600015, 120003) - previous, 15);
assert.equal(gaps.at(-1)[1].missing, 2);
assert(Number.isNaN(timeline(600015, 120003)), 'duplicate rejected');
previous = S.dev.lastPage;
assert(timeline(0, 1) > previous, 'reboot remains monotonic');
assert.equal(gaps.at(-1)[0], 'device_timeline_resync');
S.dev = {lastMcu: 0xfffffffd, lastSeq: 0xffffffff, lastPage: 100};
const n = gaps.length;
assert.equal(timeline(2, 0), 105);
assert.equal(gaps.length, n, 'normal uint32 wrap is continuous');
assert(Number.isNaN(timeline(-1, 1)));
const activeDurationMs = new Function('activeDurationMs', 'return activeDurationMs;')(
  new Function('session', 'from', 'to', extract('activeDurationMs') + '; return activeDurationMs;')()
);
assert.equal(activeDurationMs({segments:[
  {start_timeline_ms:0, end_timeline_ms:1000},
  {start_timeline_ms:2000, end_timeline_ms:3000}
]}, 0, 3000), 2000);
const liveState = {
  session:{config:{refractoryMs:300,baselineAlpha:0.0005,releaseRatio:0.45}},
  inBlink:false, refractoryUntil:0, baseline:2048, thDown:2030, thUp:2039.9,
  dropCounts:18, events:[], rec:{ev:[]}, minInBlink:0, fallingMs:0
};
const liveDetect = new Function('S','CFG','setBlinkCount','pushStats','sampleUtc','addEvent','ui',
  extract('detect') + '; return detect;')(
    liveState, {maxEvents:5000}, ()=>{}, ()=>{}, (t)=>t, ()=>{}, {mLast:{textContent:''}});
for (let i=0;i<12000;i++) liveDetect(i*5,2100);
assert(Math.abs(liveState.thDown - (liveState.baseline - 18)) < 1e-9,
  'live threshold must follow baseline while preserving the configured drop');
const select = new Function(extract('selectBleChannels') + ';return selectBleChannels;')();
const uuid = n => `0000${n}-0000-1000-8000-00805f9b34fb`;
const char = (n, properties) => ({uuid: uuid(n), properties});
const vg = [char('ffe1', {writeWithoutResponse: true}), char('ffe2', {notify: true})];
assert.equal(select(uuid('ffe0'), vg).notify, vg[1]);
assert.equal(select(uuid('ffe0'), vg).write, vg[0]);
const eb = [char('fff3', {write: true, notify: true}), char('fff2', {write: true}), char('fff1', {notify: true})];
assert.equal(select(uuid('fff0'), eb).notify, eb[2]);
assert.equal(select(uuid('fff0'), eb).write, eb[1]);
assert.throws(() => select(uuid('ffe0'), [char('aaa1', {notify:true}), char('aaa2', {notify:true})]));
const kt = [char('ffe1', {notify:true, write:true})];
assert.equal(select(uuid('ffe0'), kt).notify, kt[0]);
(async () => {
  const state = {writeChain: Promise.resolve(), session: {}, phase:'RUN'};
  const ui = {help: {textContent:''}};
  const api = new Function('S','ui','openDb','console','lockSessionInputs','refreshButtons','setState','flushChunk',
    extract('enqueueWrite') + extract('waitForWrites') + '; return {enqueueWrite,waitForWrites};')(
      state, ui, async()=>({}), {error(){}}, ()=>{}, ()=>{}, ()=>{}, async()=>{});
  await assert.rejects(api.enqueueWrite(async()=>{throw Error('quota failure');}));
  await state.writeChain;
  await api.enqueueWrite(async()=>{});
  await assert.rejects(api.waitForWrites(), /quota failure/);
  assert.equal(state.phase, 'STOPPED');
  assert.match(ui.help.textContent, /未完整保存/);
  console.log('PASS: 10-minute timeline, gaps, duplicates, reboot, wrap, BLE profiles, persistent storage failure');
})().catch(err => { console.error(err); process.exitCode = 1; });
