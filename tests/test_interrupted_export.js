const assert = require('node:assert/strict');
const {loadPage} = require('./helpers/page');

(async () => {
  const page = loadPage('test.html', {session:true});
  const {app:a} = page;
  try {
    a.S.connected = true;
    await a.beginFormalSession();
    const id = a.S.session.id;
    for (let i=0;i<1250;i++) a.onSample(1000+i*5,2048);
    a.addEvent('pause',a.S.lastT,a.S.session.last_utc_ms);
    await a.S.writeChain;
    await assert.rejects(() => a.exportBundle(), /先结束测试/);
    assert.equal(page.downloads.length,0,'do not export an active test');

    // Reload would lose the uncommitted 50 samples. Keep only persisted state.
    a.S.currentChunk = null;
    a.S.phase = 'IDLE';
    a.S.session = null;
    await a.refreshSessionList();
    a.ui.sessionList.value = id;
    await a.exportSelectedSession();
    const snapshot = JSON.parse(await page.downloads.at(-1).text());
    assert.equal(snapshot.metadata.status,'interrupted_snapshot');
    assert.equal(snapshot.metadata.quality.received,1200);
    assert.equal(snapshot.metadata.last_timeline_ms,1000+1199*5);
    assert.equal(snapshot.metadata.segments[0].end_timeline_ms,snapshot.metadata.last_timeline_ms);
    assert.equal(snapshot.metadata.snapshot_export.excluded_events,1);
    assert.equal(snapshot.metadata.ended_utc_ms,null,'do not invent an end time');
    assert.equal((await a.readSessionRecord(id)).status,'recording','the stored record must remain untouched');
    assert.equal(a.validateImport(snapshot).length,1);

    await a.exportAllSessions();
    const batch = JSON.parse(await page.downloads.at(-1).text());
    assert.equal(batch.sessions[0].metadata.status,'interrupted_snapshot');
    const [copy] = await a.importData(snapshot);
    assert.equal((await a.buildBundle(await a.readSessionRecord(copy))).metadata.status,'interrupted_snapshot');
    assert.equal(page.errors.length,0,page.errors.join('\n'));
  } finally { page.close(); }
  console.log('PASS recover persisted chunks for stale recording; active export blocked; incomplete snapshot round-trips');
})().catch(err => { console.error(err); process.exitCode=1; });
