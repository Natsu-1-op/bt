const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page');

(async () => {
  for (const page of ['index.html', 'test.html']) {
    const e = loadPage(page);
    try {
      const a = e.app;
      a.applyConsoleConfig({ minDropCounts: 8, manualDropCounts: 8, manualThresholdEnabled: true, blinkCalEnabled: false });
      a.S.connected = true;
      await a.beginFormalSession();
      for (let t = 1000; t <= 5000; t += 5) a.onSample(t, 2048);
      a.breakSampleContinuity('sample_gap', { missing: 1000 });
      for (let t = 10000; t <= 12000; t += 5) {
        const phase = t - (t < 10600 ? 10000 : 10600);
        a.onSample(t, phase >= 0 && phase < 150 ? 2048 - Math.round(80 * Math.sin(Math.PI * phase / 150)) : 2048);
      }
      await a.stopSession('user');
      await a.S.writeChain;
      const b = await a.buildBundle(JSON.parse(JSON.stringify(a.S.session)));
      const detector = a.makeOfflineDetector(b.metadata.config, b.metadata.detector.drop_counts);
      const events = b.sample_chunks.flatMap(c => c.rows).map(detector).filter(Boolean);
      assert.equal(a.S.count, 1, 'only the later blink counts; first post-gap pulse is quarantined');
      assert.deepEqual(Array.from(a.S.events, ev => ev.t), Array.from(events, ev => ev.t), page + ': live/replay gap recovery');
      await assert.rejects(a.visitChunks(b.metadata.id, () => { throw new Error('cursor visitor failed'); }), /cursor visitor failed/);
      assert.equal(e.errors.length, 0, e.errors.join('\n'));
    } finally { e.close(); }

    const invalid = loadPage(page);
    try {
      const a = invalid.app;
      a.S.connected = true;
      await a.beginFormalSession();
      for (let t = 4000; t <= 7000; t += 5) a.onSample(t, 0);
      await a.S.writeChain;
      assert.equal(a.S.phase, 'STOPPED');
      assert.equal(a.S.session.status, 'calibration_invalid');
      assert.equal(a.S.activeSegment, null, 'invalid calibration closes its segment');
      assert.equal(a.S.session.segments[0].end_timeline_ms, 7000);
      let rows = 0;
      await a.visitChunks(a.S.session.id, chunk => { rows += chunk.rows.length; });
      assert.equal(rows, 601, 'invalid calibration retains the last partial chunk');
      assert.equal(a.S.currentChunk, null);
      assert.equal(invalid.errors.length, 0, invalid.errors.join('\n'));
    } finally { invalid.close(); }
  }
  console.log('PASS both pages: gap quarantine matches replay; invalid calibration is fully stored; cursor errors reject');
})().catch(err => { console.error(err); process.exitCode = 1; });
