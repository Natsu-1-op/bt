const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page');

(async () => {
  const page = loadPage('test.html', {session:true});
  const { app:a, w, clock } = page;
  const $ = id => w.document.getElementById(id);
  try {
    a.applyConsoleConfig({minDropCounts:8, noiseMultiplier:4, blinkCalEnabled:false, manualThresholdEnabled:false});
    a.S.connected = true;
    await a.beginFormalSession();
    const pulses = [30000, 32000, 34000, 36000];
    for (let t = 1000; t < 38500; t += 5) {
      const ph = pulses.map(start => t - start).find(dt => dt >= 0 && dt < 160);
      let raw = t <= 4000 ? 2048 + 48*Math.sin(2*Math.PI*8*t/1000) : 2048 + (t/5)%3 - 1;
      if (ph !== undefined) raw += (t >= 36000 ? 1 : -1) * 23 * Math.sin(Math.PI * ph / 160);
      if (t === 37000) raw = 0; // an ADC rail hit must not become a blink
      a.onSample(t, Math.round(raw));
    }
    await a.stopSession('user_stop');
    const session = a.S.session;
    const seed = session.detector.drop_counts;
    assert(seed > 50, 'the initial interference must raise the initial threshold');
    const bundle = await a.buildBundle(session);
    const rows = bundle.sample_chunks.flatMap(c => c.rows);
    const old = a.makeOfflineDetector(session.config, seed, null, false);
    assert.equal(rows.map(old).filter(ev => ev && ev.t < 37000).length, 0, 'the old fixed threshold must miss these shallow pulses');
    const live = bundle.events.filter(ev => ev.type === 'blink');
    assert.equal(live.length, pulses.length);
    assert.equal(live.at(-1).polarity, 'rise', 'a shallow/reversed downward lobe cannot mask an adequate upward pulse');
    assert(live.every(ev => ev.threshold_counts >= 8 && ev.threshold_counts < 20));
    const offline = rows.map(a.makeOfflineDetector(session.config, seed)).filter(Boolean);
    assert.equal(JSON.stringify(offline.map(ev => [ev.t,ev.width,ev.amp,ev.threshold_counts])),
      JSON.stringify(live.map(ev => [ev.timeline_ms,ev.width_ms,ev.amplitude_counts,ev.threshold_counts])));
    assert.equal(session.detector.drop_counts, seed, 'preserve the start threshold');

    const noisy = a.makeAdaptiveThreshold(session.config, 8);
    for(let i=0;i<2400;i++) noisy.push(i*5,2048+45*Math.sin(i*0.24),2048);
    assert(noisy.drop > 80, 'persistent noise must not get a low threshold');
    const zeroFloor = a.makeAdaptiveThreshold({...session.config,minDropCounts:0,noiseMultiplier:0}, 8);
    for(let i=0;i<3600;i++) zeroFloor.push(i*5,2048,2048);
    assert(zeroFloor.drop < 2, 'no hidden fixed floor');
    const fast = a.makeAdaptiveThreshold(session.config, 180, true);
    const slow = a.makeAdaptiveThreshold(session.config, 180);
    for(let i=0;i<1600;i++) { fast.push(i*5,2048,2048); slow.push(i*5,2048,2048); }
    assert(fast.drop < slow.drop, 'a consistently quiet run should shed an inflated initial threshold sooner');
    const burst = a.makeAdaptiveThreshold(session.config,4,true,true);
    const whole = a.makeAdaptiveThreshold(session.config,4,true);
    const sustained = a.makeAdaptiveThreshold(session.config,4,true,true);
    const sustainedLegacy = a.makeAdaptiveThreshold(session.config,4,true);
    for(let i=0;i<400;i++){
      const transient=2048+(i<100?75:3)*Math.sin(i*.4), ongoing=2048+75*Math.sin(i*.4);
      burst.push(i*5,transient,2048);whole.push(i*5,transient,2048);
      sustained.push(i*5,ongoing,2048);sustainedLegacy.push(i*5,ongoing,2048);
    }
    assert(burst.drop<whole.drop && burst.drop>=whole.drop*.7);
    assert.equal(sustained.drop,sustainedLegacy.drop,'continuous noise must not be discounted');

    const gate = a.makeBipolarGate({...session.config,refractoryMs:0},2048);
    const signals = [];
    for(let t=0;t<1000;t+=5){
      const shape = t>=150 && t<280 ? -30*Math.sin(Math.PI*(t-150)/130)
        : t>=280 && t<410 ? 38*Math.sin(Math.PI*(t-280)/130) : 0;
      const ev = gate.push(t,2048+shape,10,t);
      if(ev) signals.push(ev);
    }
    assert.equal(signals.length,1,'opposite rebound must not duplicate a blink even with zero configured interval');
    const driftGate = a.makeBipolarGate(session.config,2048);
    let driftEvents = 0;
    for(let t=0;t<3000;t+=5) {
      const slowlyVarying = t<1500 ? t*0.016 : (3000-t)*0.016;
      if(driftGate.push(t,2048+slowlyVarying,10,t)) driftEvents++;
    }
    assert.equal(driftEvents,0,'slow positive baseline motion does not qualify as a rise');

    // Large historic files include a stop event after the last sample, but
    // detections are never allowed past the waveform boundary.
    const older = structuredClone(bundle);
    const stop = older.events.find(ev => ev.type === 'user_stop');
    stop.timeline_ms = older.metadata.last_timeline_ms + 560;
    stop.utc_ms = older.metadata.ended_utc_ms = older.metadata.last_utc_ms + 560;
    assert.equal(a.validateImport(older).length, 1);
    stop.type = 'blink';
    assert.throws(() => a.validateImport(older), /事件数据无效/);

    const snapshot = JSON.stringify(session);
    await a.startReplay();
    assert(!$('trialAdaptive').disabled);
    const job = a.applyReplayTrial(true);
    await clock.tickAsync(100);
    await job;
    const trial = a.S.replay.trial;
    assert.equal(trial.events.length, pulses.length);
    assert.equal(trial.algorithm, 'replay-adaptive-bipolar/v3');
    assert.match($('trialStatus').textContent, /自适应候选/);
    assert.equal(JSON.stringify(session), snapshot);
    await a.exportReplayComparison();
    const comparison = JSON.parse(await page.downloads.at(-1).text());
    assert.equal(a.validateImport(comparison).length, 1);
    const invalid = structuredClone(comparison);
    invalid.reanalysis.config.minDropCounts = 0;
    assert.throws(() => a.validateImport(invalid), /配置.*不一致/);
    const ids = await a.importData(comparison);
    a.ui.sessionList.value = ids[0];
    await a.loadSelectedSession();
    await a.startReplay();
    assert.equal(a.S.replay.trial.algorithm, trial.algorithm);
    assert.equal(JSON.stringify(a.S.replay.trial.events), JSON.stringify(trial.events));
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
  } finally {
    page.close();
  }
  console.log('PASS adaptive shallow blink recovery, sustained noise, clipping, live/replay and export/import parity');
})().catch(err => { console.error(err); process.exitCode=1; });
