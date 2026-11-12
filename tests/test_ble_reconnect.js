const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page');

(async () => {
  for (const page of ['index.html', 'test.html']) {
    const e = loadPage(page);
    try {
      const a = e.app, w = e.w;
      let release, requests = 0;
      const device = new w.EventTarget();
      const notify = new w.EventTarget();
      notify.uuid = '0000ffe2-0000-1000-8000-00805f9b34fb';
      notify.properties = { notify: true };
      notify.startNotifications = async () => notify;
      let writes = 0;
      const writer = { uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', properties: { write: true }, writeValueWithResponse: async () => { writes++; } };
      const service = { uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', getCharacteristics: async () => [notify, writer] };
      device.name = 'test device';
      device.gatt = { connected: true, connect: async () => ({ getPrimaryService: async () => service }), disconnect() { this.connected = false; device.dispatchEvent(new w.Event('gattserverdisconnected')); } };
      Object.defineProperty(w.navigator, 'bluetooth', { value: { requestDevice() { requests++; return new Promise(r => { release = r; }); } } });
      const pending = a.connect();
      assert.equal(a.ui.btnConn.disabled, true);
      await a.connect();
      assert.equal(requests, 1, 'overlapping connection requests are ignored');
      release(device);
      await pending;
      assert.equal(a.S.connected, true);
      assert.equal(a.ui.btnConn.disabled, false);
      a.onDisconnected({ target: new w.EventTarget() });
      assert.equal(a.S.connected, true, 'old device disconnect cannot destroy the new connection');
      const originalWrite = a.S.writeFn;
      a.S.writeChar = { writeValueWithResponse() { throw new Error('wrong characteristic'); } };
      await originalWrite(new Uint8Array([1]));
      assert(writes > 0, 'writer captures its own characteristic');
      device.gatt.disconnect();
      assert.equal(a.S.connected, false);
      assert.equal(a.S.writeFn, null);
    } finally { e.close(); }
  }
  console.log('PASS both pages: serialized connect, stale disconnect ignored, characteristic-bound writer');
})().catch(err => { console.error(err); process.exitCode = 1; });
