"use strict";
(() => {
  // ------------------------------------------------------------------
  // 参数
  // ------------------------------------------------------------------
  const CFG = {
    adcMax: 4095,
    vref: 3.3,
    sampleRateHz: 200,
    maLength: 8,             // 8 点滑动平均：200Hz 下正好在 25/50/75Hz 零点，顺带压 50Hz
    calibrationMs: 3000,
    calibrationSkipMs: 300,  // 标定开头这段时间的样本不参与阈值计算（见 onSample 里的说明）
    // 噪声估计与电极漂移监测
    noiseDetrendWindowMs: 500,      // 算 sigma 前先减掉这么长的滑动平均（去慢漂移）
    calibrationDriftWarnCounts: 5,  // 标定窗口内漂移超过这么多 counts 就在现场提示电极不稳
    // ---- 现场眨眼标定（方案 C）----
    // 只靠噪声推算阈值，在信号很干净时会过于保守：实测某段 σ=1.00，阈值却被定成 12（=12σ），
    // 受试者浅浅的眨眼就检不出来。这一步直接量「这个受试者此刻真实的眨眼有多深」。
    // 默认关闭：需要操作者配合，培训好之前在调试台里保持关闭。
    blinkCalRatio: 0.6,             // 阈值 = 标定到的最小眨眼深度 × 这个比例
    blinkCalTarget: 5,              // 目标眨眼次数
    blinkCalMinAccepted: 3,         // 至少记录到这么多次才采信，否则退回噪声法
    blinkCalMaxMs: 20000,           // 超时（毫秒），避免一直等
    blinkCalMinWidthMs: 100,        // 候选眨眼的最小宽度：真眨眼一般 >=100ms，窄脉冲是噪声
    blinkCalProvisionalSigma: 2.5,  // 标定期间用的临时阈值倍数，要比正式灵敏，否则量不到浅眨眼
    blinkCalProvisionalFloor: 6,    // 临时下限的默认上限；现场下限更小时跟随降低
    noiseMultiplier: 4,
    minDropCounts: 12,
    releaseRatio: 0.45,      // 回升到凹陷深度的 45% 就算脱离
    minWidthMs: 40,
    maxWidthMs: 800,
    refractoryMs: 300,
    baselineAlpha: 0.0005,   // 极慢基线跟踪，约 10 秒时间常数
    liveWindowMs: 8000,      // 波形显示最近 8 秒
    autoRangeMinHalf: 16,    // 纵轴自适应时的半幅下限：信号平直时不能把噪声放大成假波形
    realtimeWindowMs: 30000, // 实时频率窗口
    maxRecordMs: 15 * 60 * 1000,
    maxEvents: 5000,
    sampleTimeoutMs: 3000
  };

  const SERVICE_UUID = 0xffe0;
  const isConsolePage = document.body.dataset.page === 'console';

    // 调试台已经搬到 test.html，index.html 里这些元素不存在了。
    // 残留的绑定（refreshButtons、updateDebugControls 等）仍然会去碰它们，
    // 所以这里返回一个什么都不做的空壳，而不是 null —— 否则加载时就会抛。
    const RETIRED_CONSOLE_IDS = new Set(['fMult', 'fRefr', 'manualThresholdEnabled', 'manualDrop',
      'debugPanel', 'debugGateStatus', 'btnDebugClose', 'debugReadout',
      'oledText', 'btnOledSend', 'oledImage', 'oledImagePreview', 'oledImageStatus',
      'btnOledImageCenter', 'btnOledImageSend', 'btnOledImageClear',
      'otaFile', 'btnOta', 'otaStatus', 'fMinDrop', 'fBlinkCal', 'fBlinkCalRatio',
      'loginGate', 'loginPass', 'loginBtn', 'loginError', 'btnConsoleSave', 'btnConsoleLoad', 'btnConsoleLogout', 'consoleStatus']);
    // 空壳元素必须能当 canvas 用。残留代码里有几处在【加载时】就会画一次预览
    // （clearOledImagePreview），getContext 一旦返回 null，整个脚本会在加载时抛错，
    // 后面所有事件绑定都不执行 —— 表现就是"页面打得开，但什么都点不动"。
    const stubCtx = () => new Proxy({}, {
      get(t, k) {
        if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
        if (k === 'measureText') return () => ({ width: 16 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (k in t) return t[k];
        return () => {};
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    const stubElement = () => ({
      textContent: '', innerHTML: '', value: '', checked: false, disabled: false, files: null,
      width: 128, height: 32,
      style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {}, append() {}, appendChild() {},
      getContext: () => stubCtx(),
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
      onclick: null, oninput: null, onchange: null, onkeydown: null,
    });
    const $ = (id) => {
      const el = document.getElementById(id);
      if (el) return el;
      // 只有「已知下线的调试台元素」才静默给空壳。
      // 其它 id 缺失说明是拼错了或者 HTML 被改坏了 —— 必须吼出来，
      // 否则会被空壳静默吞掉，变成"怎么点都没反应"的幽灵 bug。
      if (isConsolePage || !RETIRED_CONSOLE_IDS.has(id)) throw new Error('页面缺少元素 #' + id);
      return stubElement();
    };
  const ui = {
    btnConn: $('btnConn'), btnStart: $('btnStart'), btnPause: $('btnPause'), btnStop: $('btnStop'),
    btnClear: $('btnClear'), btnAnalyze: $('btnAnalyze'),
    btnFull: $('btnFull'), btnLoad: $('btnLoad'), btnExportBundle: $('btnExportBundle'),
    appTitle: $('appTitle'), debugPanel: $('debugPanel'), debugGateStatus: $('debugGateStatus'), btnDebugClose: $('btnDebugClose'),
    oledText: $('oledText'), btnOledSend: $('btnOledSend'),
    oledImage: $('oledImage'), oledImagePreview: $('oledImagePreview'), btnOledImageCenter: $('btnOledImageCenter'), oledImageStatus: $('oledImageStatus'),
    btnOledImageSend: $('btnOledImageSend'), btnOledImageClear: $('btnOledImageClear'),
    otaFile: $('otaFile'), btnOta: $('btnOta'), otaStatus: $('otaStatus'),
    dot: $('dot'), conn: $('conn'), help: $('help'),
    mState: $('mState'), mCount: $('mCount'), mBpm: $('mBpm'), mLast: $('mLast'),
    fT0: $('fT0'), fT1: $('fT1'), fWin: $('fWin'), fStep: $('fStep'), fMult: $('fMult'), fRefr: $('fRefr'),
    subjectId: $('subjectId'), deviceId: $('deviceId'), operatorId: $('operatorId'), condition: $('condition'),
    manualThresholdEnabled: $('manualThresholdEnabled'), manualDrop: $('manualDrop'), debugReadout: $('debugReadout'),
    autoRange: $('autoRange'),
    sessionList: $('sessionList'), btnDeleteSession: $('btnDeleteSession'),
    btnExportOne: $('btnExportOne'), btnExportAll: $('btnExportAll'),
    cloudGate: $('cloudGate'), cloudSpin: $('cloudSpin'), cloudTitle: $('cloudTitle'),
    cloudMsg: $('cloudMsg'), cloudActions: $('cloudActions'), cloudStart: $('cloudStart'), cloudCancel: $('cloudCancel'),
    fMinDrop: $('fMinDrop'), fBlinkCal: $('fBlinkCal'), fBlinkCalRatio: $('fBlinkCalRatio'),
    loginGate: $('loginGate'), loginPass: $('loginPass'), loginBtn: $('loginBtn'), loginError: $('loginError'),
    btnConsoleSave: $('btnConsoleSave'), btnConsoleLoad: $('btnConsoleLoad'), btnConsoleLogout: $('btnConsoleLogout'), consoleStatus: $('consoleStatus'),
    sAvg: $('sAvg'), sCount: $('sCount'), sDur: $('sDur'), sWin: $('sWin')
  };

  // ------------------------------------------------------------------
  // 状态
  // ------------------------------------------------------------------
  const S = {
    connected: false, hasWrite: false, busy: false,
    viewingHistory: false, timeoutHandling: false, disconnectPending: false,
    phase: 'IDLE',            // IDLE | CAL | RUN | PAUSE | STOPPED
    device: null, notifyChar: null, writeChar: null,
    // 下发给设备（OLED 镜像）用的状态。
    // shownBpm 的语义是「网页上此刻显示的那个频率」—— 它是唯一真值来源，
    // 设备侧的显示只允许从它来，这样才不会出现「网页一个频率、设备另一个」。
    shownBpm: null,           // 次/分；null = 网页显示的是 --
    writeFn: null,            // 写入闭包（有的模块只支持 writeWithoutResponse）
    bleWriteChain: Promise.resolve(),
    // 统计命令只保留最新一条；不要让每 500ms 的重复刷新在图片传输后排成长队。
    statsLastLine: '', statsQueuedLine: '', statsWritePending: false,
    // 设备时间轴锚点：把单片机的采样时间戳映射到网页时间轴上。
    // 之所以需要它，见 deviceTimeline() 上面的说明。
    dev: { lastMcu: null, lastPage: null, lastSeq: null },
    rx: '',

    ma: [], maSum: 0,
    cal: [], calStartMs: 0,
    baseline: 0, mad: 0, noise: 1, dropCounts: 0, thDown: 0, thUp: 0,
    // 波形纵轴量程。center=null 表示还没定过，下一帧直接取当前窗口的值。
    range: { center: null, half: CFG.adcMax / 2 },
    // 现场眨眼标定的中间状态
    blinkCal: { depths: [], startMs: null },
    // 控制台参数。以前从调试台的输入框读，现在调试台搬走了，只留一份内存副本，
    // 由每次开始测试前的云端同步 applyConsoleConfig() 灌进来。
    consoleConfig: { noiseMultiplier: CFG.noiseMultiplier, refractoryMs: CFG.refractoryMs,
                     manualThresholdEnabled: false, manualDropCounts: 60, minDropCounts: CFG.minDropCounts,
                     blinkCalEnabled: false, blinkCalRatio: CFG.blinkCalRatio },

    inBlink: false, fallingMs: 0, minInBlink: 0, refractoryUntil: 0,
    count: 0,
    events: [],               // {t, amp, width}
    samples: [],              // 最近用于画波形的点 {t, raw, filt}

    rec: { t: [], raw: [], filt: [], ev: [] },
    recStartMs: 0, recEndMs: 0,

    lastT: 0, lastSampleAt: 0, recordingStartedAt: 0,
    session: null, currentChunk: null, chunkIndex: 0, writeChain: Promise.resolve(), writeError: null,
    db: null, activeSegment: null, nextEventId: 1,
    quality: { received: 0, saturatedLow: 0, saturatedHigh: 0 },
    clock: { anchorTimeline: null, anchorUtc: null, lastWallOffset: null },
    oledImageBitmap: null, oledImageName: '', oledImageUrl: '', oledImageElement: null,
    displayMode: 'text', cloudDisplayHex: '', displayRevision: 0,
    oledImageOffsetX: 0, oledImageOffsetY: 0, oledImageGeometry: null, oledImageDrag: null,
    ota: { running: false, waiter: null },
    consoleConfigDirty: false, consoleAuthenticated: false
  };

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const DB_NAME = 'blink-collector-v1', DB_VERSION = 1, CHUNK_SAMPLES = 400; // 200 Hz 下每块约 2 秒，降低异常退出时的未提交数据量
  const iso = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  const newId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function openDb() {
    if (S.db) return Promise.resolve(S.db);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('当前浏览器不能可靠保存测试数据。')); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] });
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: ['sessionId', 'id'] });
      };
      request.onsuccess = () => { S.db = request.result; resolve(S.db); };
      request.onerror = () => reject(request.error || new Error('无法打开本机采集数据库'));
    });
  }

  function enqueueWrite(work) {
    const next = S.writeChain.then(() => openDb()).then(work);
    S.writeChain = next.catch(err => {
      S.writeError = String(err && err.message || err);
      console.error(err);
      if (S.session) S.session.storage_error = S.writeError;
      S.phase = 'STOPPED'; S.inBlink = false;
      lockSessionInputs(false); refreshButtons();
      setState('保存失败', 'badc');
      ui.help.textContent = '本次数据未完整保存，请重新测试。请先检查浏览器是否允许本机存储、设备空间是否充足。';
    });
    return next;
  }

  function persistSession() {
    if (!S.session) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(S.session));
    return enqueueWrite(db => new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(snapshot);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }));
  }

  function flushChunk() {
    const chunk = S.currentChunk;
    if (!chunk || !chunk.rows.length) return Promise.resolve();
    S.currentChunk = null;
    return enqueueWrite(db => new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(chunk);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    })).catch(err => {
      // Keep an uncommitted block available for a retry and a clear diagnostic.
      if (!S.currentChunk || S.currentChunk.index !== chunk.index) S.currentChunk = chunk;
      throw err;
    });
  }

  function persistEvent(event) {
    if (!S.session) return;
    enqueueWrite(db => new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').put(event);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }));
  }

  async function waitForWrites() {
    await flushChunk(); await S.writeChain;
    if (S.writeError) throw new Error(`本次数据保存不完整：${S.writeError}。请重新测试。`);
  }

  function visitChunks(sessionId, visit) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
      const request = tx.objectStore('chunks').openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        visit(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }));
  }

  function readEvents(sessionId) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readonly');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
      const request = tx.objectStore('events').getAll(range);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }));
  }

  // 删除一整条本机测试：会话本身 + 它的全部数据块 + 全部事件。
  // 三个 store 放在同一个事务里：中途失败整体回滚，不会留下没有会话的孤儿数据块。
  // 走和写入同一条队列（enqueueWrite），避免刚删完又被在途的写入写回来。
  function deleteSession(sessionId) {
    return enqueueWrite(db => new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'chunks', 'events'], 'readwrite');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
      tx.objectStore('sessions').delete(sessionId);
      tx.objectStore('chunks').delete(range);
      tx.objectStore('events').delete(range);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('删除事务被中止'));
    }));
  }

  function saveBlob(name, type, parts) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob(parts, { type }));
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = Float64Array.from(arr).sort();
    const n = a.length;
    return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  // 去漂移的噪声估计。
  // ⚠️ 为什么必须去漂移：sigma 原本是拿 |样本 − 基线| 的中位数算的，
  //    但慢漂移【不是噪声】，却照样被算进"偏差"里。实测一段标定窗口 3 秒内漂了 7 counts，
  //    sigma 就从 1.93 虚涨到 3.89 —— 阈值跟着抬高，浅眨眼全被漏掉。
  //    漂移的来源是电极整定 / 运动 / 呼吸，跟电磁干扰无关（电磁干扰主要在高频，而 50Hz 已被
  //    8 点滑动平均在 200Hz 下的零点压掉了）。
  // 做法：先减掉 0.5 秒滑动平均（去掉慢于约 1Hz 的成分），再对残差算 MAD。
  // 这和判决器本身的看法是一致的：比 1Hz 更慢的东西由基线跟踪去跟，不算噪声。
  function robustNoise(samples) {
    if (!samples || samples.length < 8) return 1;
    const W = Math.max(2, Math.round(CFG.sampleRateHz * CFG.noiseDetrendWindowMs / 1000));
    const hp = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const a = Math.max(0, i - W), b = Math.min(samples.length, i + W + 1);
      let sum = 0;
      for (let j = a; j < b; j++) sum += samples[j];
      hp[i] = samples[i] - sum / (b - a);
    }
    return Math.max(1, 1.4826 * median(hp.map(v => Math.abs(v))));
  }

  // 标定窗口内的基线漂移量：末四分之一的中位数 − 首四分之一的中位数。
  // 中位数而不是均值 —— 窗口里混进一次眨眼也不至于把结论带偏。
  function calibrationDrift(samples) {
    if (!samples || samples.length < 8) return 0;
    const q = Math.max(1, Math.floor(samples.length / 4));
    const measured = median(samples.slice(-q)) - median(samples.slice(0, q));
    // ⚠️ 首/末四分位的中位数分别落在窗口的 1/8 和 7/8 处，所以量到的是【总漂移的 3/4】。
    //    不换算回来，报告的数字会比实际小 25%，和"3 秒内漂了 N counts"的说法对不上。
    //    线性漂移下这个换算是精确的；非线性漂移下是近似 —— 作为现场提示足够了。
    return measured / 0.75;
  }

  function setConnText(t, online) {
    ui.conn.textContent = t;
    ui.dot.classList.toggle('on', !!online);
  }

  function setState(name, cls) {
    ui.mState.textContent = name;
    ui.mState.className = cls;
  }

  function refreshButtons() {
    const replayName=document.getElementById('replayRecordName');
    if(replayName)replayName.textContent=S.session ? `当前记录：${S.session.participant_id || '未命名'} · ${iso(S.session.created_utc_ms).replace('T',' ').slice(0,19)} UTC` : '请先打开一条记录';
    const c = S.connected;
    const running = S.phase === 'RUN', paused = S.phase === 'PAUSE',
          cal = S.phase === 'CAL' || S.phase === 'BLINKCAL';
    ui.btnStart.disabled = !c || running || paused || cal || S.startPending;
    ui.btnStart.textContent = (paused || S.phase === 'STOPPED') ? '重新开始测试' : '开始测试';
    ui.btnPause.disabled = !(running || paused);
    ui.btnPause.textContent = paused ? '继续测试' : '暂停测试';
    ui.btnStop.disabled = !(running || paused || cal);
    const hasSession = !!S.session;
    ui.btnClear.disabled = !(hasSession || S.count);
    ui.btnExportBundle.disabled = !hasSession || running || paused || cal;
    ui.btnAnalyze.disabled = !hasSession;
    ui.btnFull.disabled = !hasSession;
    ui.btnLoad.disabled = running || paused || cal || S.busy;
    ui.btnDeleteSession.disabled = !ui.sessionList.value || running || paused || cal || S.busy;
    ui.btnExportOne.disabled = !ui.sessionList.value || running || paused || cal || S.busy;
    ui.btnExportAll.disabled = running || paused || cal || S.busy;
    ui.btnConsoleLoad.disabled = running || paused || cal || S.busy;
    ui.btnOledSend.disabled = !S.connected || !S.writeFn || S.busy;
    ui.btnOledImageSend.disabled = !S.connected || !S.writeFn || S.busy || !S.oledImageBitmap;
    ui.btnOledImageClear.disabled = !S.oledImageBitmap;
    ui.btnOledImageCenter.disabled = !S.oledImageElement || S.busy;
    ui.btnOta.disabled = !S.connected || !S.writeFn || running || paused || cal || S.busy ||
      S.ota.running || !ui.otaFile.files || !ui.otaFile.files.length;
    if (S.busy) [ui.btnConn, ui.btnStart, ui.btnStop, ui.btnClear, ui.btnExportBundle, ui.btnPause, ui.btnAnalyze, ui.btnFull, ui.btnLoad, ui.btnOledSend, ui.btnOta].forEach(b => { b.disabled = true; });
    for(const id of ['btnImport','btnReplay']) {
      const b=document.getElementById(id);
      if(b)b.disabled=S.busy || S.startPending || running || paused || cal || (id==='btnReplay' && !hasSession);
    }
    for(const id of ['btnReplayStop','replaySeek']) {
      const b=document.getElementById(id);if(b)b.disabled=S.busy || !S.replay;
    }
    for(const id of ['trialDrop','trialRefractory','trialReset','trialExport']) {
      const b=document.getElementById(id);if(b)b.disabled=S.busy || !S.replay;
    }
  }

  // ------------------------------------------------------------------
  // 信号处理：滑动平均 + 眨眼判决
  // ------------------------------------------------------------------
  function pushMA(v) {
    const n = CFG.maLength;
    S.ma.push(v); S.maSum += v;
    if (S.ma.length > n) S.maSum -= S.ma.shift();
    return S.maSum / S.ma.length;
  }

  function resetFilter() { S.ma = []; S.maSum = 0; }

  // 标定阶段至少应该收到多少个样本。
  // ⚠️ 必须和 onSample 里真正的取样条件一致：开头 calibrationSkipMs 不计入，
  //    所以是 (calibrationMs - calibrationSkipMs) × 采样率，不是 calibrationMs × 采样率。
  //    留 5% 余量吸收定时抖动。
  function minCalibrationSamples(sessionConfig) {
    const raw = sessionConfig ? Number(sessionConfig.calibrationSkipMs) : NaN;
    // 会话里没写这个字段（旧记录，或"加了跳过但还没写进配置"那段时间录的）
    // 就退回当前 CFG 的值 —— 偏宽松，免得把正常记录误拒。
    const skipMs = Number.isFinite(raw) ? raw : CFG.calibrationSkipMs;
    const duration = Number(sessionConfig && sessionConfig.calibrationMs);
    const rate = Number(sessionConfig && sessionConfig.sampleRateHz);
    const usableMs = Math.max(0, (duration > 0 ? duration : CFG.calibrationMs) - skipMs);
    return Math.max(1, Math.floor((rate > 0 ? rate : CFG.sampleRateHz) * usableMs / 1000 * 0.95));
  }

  function boundedInputNumber(input, fallback, min, max) {
    if (!input || input.value == null || String(input.value).trim() === '') return fallback;
    const n = Number(input.value);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  }

  function detectorConfigFingerprint(config) {
    return JSON.stringify([
      config.noiseMultiplier, config.refractoryMs, config.manualThresholdEnabled,
      config.manualDropCounts, config.minDropCounts, config.blinkCalEnabled, config.blinkCalRatio
    ]);
  }

  function thresholdDeciderText() {
    const active = ['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase);
    const config = active && S.session ? S.session.config : currentConfig();
    if (config.blinkCalEnabled) {
      if (S.phase === 'BLINKCAL') return `正在现场眨眼标定；临时下降幅度阈值 ${S.dropCounts.toFixed(2)} ADC 计数，完成后按参考深度与噪声确定正式阈值。`;
      if (active && S.session && S.session.blink_calibration) return S.session.blink_calibration.note;
      return `现场眨眼标定：阈值 = max（参考深度的 ${Math.round(config.blinkCalRatio * 100)}%，${config.noiseMultiplier}σ）。`
        + `参考深度取第20百分位；记录不足时退回 max（下限 ${config.minDropCounts}，σ × ${config.noiseMultiplier}）。此模式不使用手动阈值。`;
    }
    const minDrop = boundedInputNumber(ui.fMinDrop, CFG.minDropCounts, 0, 200);
    if (ui.manualThresholdEnabled.checked) {
      const manual = boundedInputNumber(ui.manualDrop, 60, 0, 2000);
      const eff = Math.max(minDrop, manual);
      const who = manual > minDrop
        ? `由【手动阈值 ${manual}】决定 → 改下限（现在 ${minDrop}）到 ${manual} 以下不会有任何效果`
        : `由【下限 ${minDrop}】决定 → 改手动阈值（现在 ${manual}）到 ${minDrop} 以下不会有任何效果`;
      return `手动模式：阈值 = max(下限 ${minDrop}, 手动 ${manual}) = ${eff} ADC 计数。${who}。`;
    }
    const mult = boundedInputNumber(ui.fMult, CFG.noiseMultiplier, 0, 12);
    return `自动模式：阈值 = max(下限 ${minDrop}, σ × 抗干扰等级 ${mult})。`
      + '下限与自动项哪个大由哪个决定 —— 看导出记录里的 detector.drop_counts。';
  }

  function markConsoleConfigDirty() {
    S.consoleConfigDirty = true;
    updateDebugControls();
    if (ui.consoleStatus) {
      ui.consoleStatus.textContent = '本机参数已修改，尚未保存到云端；本次测试将使用本机设置。';
    }
  }

  function currentConfig() {
    return {
      adcMax: CFG.adcMax, sampleRateHz: CFG.sampleRateHz, maLength: CFG.maLength,
      calibrationMs: CFG.calibrationMs, calibrationSkipMs: CFG.calibrationSkipMs, noiseMultiplier: boundedInputNumber(ui.fMult, CFG.noiseMultiplier, 0, 12),
      minDropCounts: boundedInputNumber(ui.fMinDrop, CFG.minDropCounts, 0, 200), releaseRatio: CFG.releaseRatio,
      blinkCalEnabled: !!ui.fBlinkCal.checked, blinkCalRatio: boundedInputNumber(ui.fBlinkCalRatio, CFG.blinkCalRatio, 0.2, 1),
      minWidthMs: CFG.minWidthMs, maxWidthMs: CFG.maxWidthMs,
      refractoryMs: boundedInputNumber(ui.fRefr, CFG.refractoryMs, 0, 2000), baselineAlpha: CFG.baselineAlpha,
      manualThresholdEnabled: ui.manualThresholdEnabled.checked,
      manualDropCounts: boundedInputNumber(ui.manualDrop, 60, 0, 2000)
    };
  }

  function lockSessionInputs(locked) {
    [ui.subjectId, ui.deviceId, ui.operatorId, ui.condition, ui.fMult, ui.fRefr, ui.manualThresholdEnabled,
     ui.fMinDrop, ui.fBlinkCal, ui.fBlinkCalRatio].forEach(input => { input.disabled = locked; });
    ui.manualDrop.disabled = locked || !ui.manualThresholdEnabled.checked;
  }

  const OLED_TEXT_STORAGE_KEY = 'blink-oled-text-v1';
  function updateDebugControls() {
    ui.manualDrop.disabled = ui.manualThresholdEnabled.disabled || !ui.manualThresholdEnabled.checked;
    ui.debugReadout.textContent = thresholdDeciderText();
  }

  function setDebugGateStatus(text) {
    if (ui.debugGateStatus) ui.debugGateStatus.textContent = text;
  }

  // Console access is password-only. No BLE query, hardware state or polling.
  function lockDebugPanel(message = '') {
    ui.debugPanel.classList.add('hidden');
    setDebugGateStatus(message);
  }

  function openDebugPanel() {
    if (!isConsolePage) return;
    if (!S.consoleAuthenticated || !consoleSessionValid()) {
      showLogin('请输入管理员密码。');
      return;
    }
    ui.debugPanel.classList.remove('hidden');
    setDebugGateStatus('');
    updateDebugControls();
  }

  if (isConsolePage) ui.appTitle.addEventListener('click', openDebugPanel);
  // 调试台中的采集参数一旦编辑，本机值优先用于下一次测试；只有点“保存到云端”才同步出去。
  // 测试期间这些输入会锁定，避免界面值和该次采集使用的快照不一致。
  [ui.manualThresholdEnabled, ui.manualDrop, ui.fMinDrop, ui.fMult, ui.fRefr, ui.fBlinkCal, ui.fBlinkCalRatio]
    .filter(Boolean)
    .forEach(input => {
      input.addEventListener('input', markConsoleConfigDirty);
      input.addEventListener('change', markConsoleConfigDirty);
    });

  const savedOledText = (() => {
    try { return JSON.parse(localStorage.getItem(OLED_TEXT_STORAGE_KEY) || '{}'); } catch (_) { return {}; }
  })();
  if (typeof savedOledText.text === 'string') ui.oledText.value = Array.from(savedOledText.text).slice(0, 16).join('');
  const saveOledText = () => {
    if (Array.from(ui.oledText.value).length > 16) {
      ui.oledText.value = Array.from(ui.oledText.value).slice(0, 16).join('');
    }
    try { localStorage.setItem(OLED_TEXT_STORAGE_KEY, JSON.stringify({ text: ui.oledText.value })); } catch (_) {}
  };
  ui.oledText.oninput = () => { S.displayMode = 'text'; S.displayRevision++; saveOledText(); };
  function getOledImageGeometry(image) {
    const iw = image && (image.naturalWidth || image.width);
    const ih = image && (image.naturalHeight || image.height);
    if (!iw || !ih) return null;
    const scale = Math.min(128 / iw, 32 / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    const baseX = (128 - dw) / 2;
    const baseY = (32 - dh) / 2;
    return {
      dw, dh, baseX, baseY,
      minOffsetX: -baseX, maxOffsetX: 128 - dw - baseX,
      minOffsetY: -baseY, maxOffsetY: 32 - dh - baseY
    };
  }
  function clearOledImagePreview() {
    const ctx = ui.oledImagePreview.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 32);
  }
  function updateOledImagePreview() {
    if (!S.oledImageElement) {
      S.oledImageBitmap = null; S.oledImageGeometry = null;
      clearOledImagePreview(); refreshButtons(); return;
    }
    const g = S.oledImageGeometry = getOledImageGeometry(S.oledImageElement);
    S.oledImageOffsetX = clamp(S.oledImageOffsetX, g.minOffsetX, g.maxOffsetX);
    S.oledImageOffsetY = clamp(S.oledImageOffsetY, g.minOffsetY, g.maxOffsetY);
    drawOledImage(S.oledImageElement, ui.oledImagePreview, S.oledImageOffsetX, S.oledImageOffsetY);
    S.oledImageBitmap = canvasToOledBitmap(ui.oledImagePreview);
    const x = Math.round(g.baseX + S.oledImageOffsetX);
    const y = Math.round(g.baseY + S.oledImageOffsetY);
    ui.oledImageStatus.textContent = `已处理：${S.oledImageName || '图片'}。位置：${x},${y}；可拖动预览调整，图片保持等比例且不裁剪。`;
    refreshButtons();
  }
  function clearOledImage() {
    if (S.displayMode === 'image') S.displayMode = 'text';
    S.displayRevision++;
    if (S.oledImageUrl) URL.revokeObjectURL(S.oledImageUrl);
    S.oledImageUrl = ''; S.oledImageBitmap = null; S.oledImageName = '';
    S.oledImageElement = null; S.oledImageGeometry = null;
    S.oledImageOffsetX = 0; S.oledImageOffsetY = 0; S.oledImageDrag = null;
    ui.oledImage.value = '';
    clearOledImagePreview();
    ui.oledImageStatus.textContent = '尚未选择图片。建议使用黑白、轮廓清晰的图片。';
    refreshButtons();
  }
  ui.oledImage.onchange = () => {
    const file = ui.oledImage.files && ui.oledImage.files[0];
    if (!file) { clearOledImage(); return; }
    if (S.oledImageUrl) URL.revokeObjectURL(S.oledImageUrl);
    const url = URL.createObjectURL(file);
    S.oledImageUrl = url; S.oledImageBitmap = null; S.oledImageName = file.name;
    S.oledImageElement = null; S.oledImageOffsetX = 0; S.oledImageOffsetY = 0;
    ui.oledImageStatus.textContent = `正在处理图片：${file.name}…`;
    refreshButtons();
    const image = new Image();
    image.onload = () => {
      if (S.oledImageUrl !== url) return;
      S.oledImageElement = image;
      S.oledImageOffsetX = 0; S.oledImageOffsetY = 0;
      updateOledImagePreview();
      URL.revokeObjectURL(url);
      S.oledImageUrl = '';
    };
    image.onerror = () => {
      if (S.oledImageUrl === url) {
        URL.revokeObjectURL(url); S.oledImageUrl = '';
        S.oledImageBitmap = null; S.oledImageName = ''; S.oledImageElement = null;
        clearOledImagePreview();
        ui.oledImageStatus.textContent = '图片读取失败，请换一个常见格式的图片。';
        refreshButtons();
      }
    };
    image.src = url;
  };
  ui.btnOledImageCenter.onclick = () => {
    if (!S.oledImageElement) return;
    S.oledImageOffsetX = 0; S.oledImageOffsetY = 0; updateOledImagePreview();
  };
  function imagePointerPosition(event) {
    const rect = ui.oledImagePreview.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * 128 / rect.width,
      y: (event.clientY - rect.top) * 32 / rect.height
    };
  }
  ui.oledImagePreview.addEventListener('pointerdown', event => {
    if (!S.oledImageElement || !S.oledImageGeometry) return;
    event.preventDefault();
    const p = imagePointerPosition(event);
    S.oledImageDrag = { id: event.pointerId, x: p.x, y: p.y, ox: S.oledImageOffsetX, oy: S.oledImageOffsetY };
    ui.oledImagePreview.classList.add('dragging');
    ui.oledImagePreview.setPointerCapture(event.pointerId);
  });
  ui.oledImagePreview.addEventListener('pointermove', event => {
    const d = S.oledImageDrag;
    if (!d || d.id !== event.pointerId || !S.oledImageGeometry) return;
    event.preventDefault();
    const p = imagePointerPosition(event), g = S.oledImageGeometry;
    S.oledImageOffsetX = clamp(d.ox + p.x - d.x, g.minOffsetX, g.maxOffsetX);
    S.oledImageOffsetY = clamp(d.oy + p.y - d.y, g.minOffsetY, g.maxOffsetY);
    updateOledImagePreview();
  });
  function finishOledImageDrag(event) {
    if (!S.oledImageDrag || S.oledImageDrag.id !== event.pointerId) return;
    S.oledImageDrag = null; ui.oledImagePreview.classList.remove('dragging');
  }
  ui.oledImagePreview.addEventListener('pointerup', finishOledImageDrag);
  ui.oledImagePreview.addEventListener('pointercancel', finishOledImageDrag);
  ui.btnOledImageClear.onclick = clearOledImage;
  clearOledImagePreview();
  ui.btnDebugClose.onclick = () => lockDebugPanel('点击标题可重新显示调试台');
  setDebugGateStatus('');
  updateDebugControls();

  function beginSegment(t, utcMs) {
    if (!S.session || S.activeSegment) return;
    S.activeSegment = { id: S.session.segments.length + 1, start_timeline_ms: t, start_utc_ms: utcMs, end_timeline_ms: null, end_utc_ms: null };
    S.session.segments.push(S.activeSegment);
  }

  function activeDurationMs(session, from, to) {
    if (!session || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
    const segments = Array.isArray(session.segments) ? session.segments : [];
    let total = 0;
    for (const seg of segments) {
      const start = Number(seg.start_timeline_ms);
      const end = Number.isFinite(Number(seg.end_timeline_ms)) ? Number(seg.end_timeline_ms) : to;
      if (!Number.isFinite(start) || end <= start) continue;
      total += Math.max(0, Math.min(end, to) - Math.max(start, from));
    }
    // Old records may not have segments. Preserve their previous interpretation.
    return total || (segments.length ? 0 : to - from);
  }

  function endSegment(t, utcMs) {
    if (!S.activeSegment) return;
    S.activeSegment.end_timeline_ms = t; S.activeSegment.end_utc_ms = utcMs;
    S.activeSegment = null;
  }

  function addEvent(type, t, utcMs, extra = {}) {
    if (!S.session) return null;
    const event = { sessionId: S.session.id, id: S.nextEventId++, type, timeline_ms: t, utc_ms: utcMs, phone_utc_iso: iso(utcMs), ...extra };
    persistEvent(event);
    return event;
  }

  // ------------------------------------------------------------------
  // 云端同步（每次开始测试前走一遍）
  // ------------------------------------------------------------------
  // 控制台配置由 test.html 维护，存在 Firebase Realtime Database 里。
  // 这里是只读方：拉到了就用，拉不到就问用户要不要直接用本机设置开始。
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyB6EbZElw7ahDN5rOK-keWlgr9JInVbnN4',
    authDomain: 'class-optic.firebaseapp.com',
    projectId: 'class-optic',
    storageBucket: 'class-optic.firebasestorage.app',
    messagingSenderId: '859111669333',
    appId: '1:859111669333:web:ec5cea5bd22dc0c495dedc',
    databaseURL: 'https://class-optic-default-rtdb.asia-southeast1.firebasedatabase.app'
  };
  const CONSOLE_CONFIG_PATH = 'blinkConsole/config';
  const CLOUD_SYNC_TIMEOUT_MS = 8000;

  let firebaseLoader = null;

  // 按需加载 Firebase SDK。刻意不做成 <script src>：
  // 没网时静态 script 会拖慢甚至卡住页面，而这是个要在诊室里用的测试页，
  // 断网也必须能立刻打开。超时就当没网处理。
  function loadFirebase() {
    if (window.firebase && window.firebase.database) return Promise.resolve(true);
    if (firebaseLoader) return firebaseLoader;
    firebaseLoader = new Promise(resolve => {
      let settled = false;
      const finish = ok => { if (!settled) { settled = true; resolve(ok); } };
      const addScript = (src, onDone) => {
        const el = document.createElement('script');
        el.src = src; el.async = true;
        el.onload = onDone; el.onerror = () => finish(false);
        document.head.appendChild(el);
      };
      addScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js', () => {
        addScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js', () => finish(true));
      });
      setTimeout(() => finish(false), CLOUD_SYNC_TIMEOUT_MS);
    });
    return firebaseLoader;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('云端请求超时')), ms);
      Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); },
                                  e => { clearTimeout(timer); reject(e); });
    });
  }

  // 成功返回配置对象；没网 / 超时 / 节点不存在都返回 null。
  async function fetchConsoleConfig() {
    if (!await loadFirebase()) return null;
    try {
      if (!window.firebase.apps || !window.firebase.apps.length) window.firebase.initializeApp(FIREBASE_CONFIG);
      const snap = await withTimeout(window.firebase.database().ref(CONSOLE_CONFIG_PATH).once('value'), CLOUD_SYNC_TIMEOUT_MS);
      const value = snap.val();
      if (!value || typeof value !== 'object') return null;
      return value;
    } catch (err) {
      console.warn('云端同步失败：', err && err.message ? err.message : err);
      return null;
    }
  }

  // 把云端配置收进来。值一律夹到合法范围 —— 云端节点是可写的，
  // 万一被写进离谱的数，这里必须兜住，不能让判决阈值变成 NaN。
  function applyConsoleConfig(cfg) {
    if (!cfg) return;
    const num = (v, fallback, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    if (ui.fMult) ui.fMult.value = String(num(cfg.noiseMultiplier, CFG.noiseMultiplier, 0, 12));
    if (ui.fRefr) ui.fRefr.value = String(num(cfg.refractoryMs, CFG.refractoryMs, 0, 2000));
    if (ui.manualDrop) ui.manualDrop.value = String(num(cfg.manualDropCounts, 60, 0, 2000));
    if (ui.manualThresholdEnabled) ui.manualThresholdEnabled.checked = !!cfg.manualThresholdEnabled;
    if (ui.fMinDrop) ui.fMinDrop.value = String(num(cfg.minDropCounts, CFG.minDropCounts, 0, 200));
    if (ui.fBlinkCal) ui.fBlinkCal.checked = !!cfg.blinkCalEnabled;
    if (ui.fBlinkCalRatio) ui.fBlinkCalRatio.value = String(num(cfg.blinkCalRatio, CFG.blinkCalRatio, 0.2, 1));
    if (typeof cfg.oledText === 'string') ui.oledText.value = Array.from(cfg.oledText).slice(0, 16).join('');
    if (isValidDisplayHex(cfg.oledBitmap)) {
      S.cloudDisplayHex = cfg.oledBitmap;
      S.displayMode = 'cloud';
      cacheDisplay(cfg.oledText || '', cfg.oledBitmap);
    }
    S.consoleConfigDirty = false;
    updateDebugControls();
  }

  function showCloudGate(mode) {
    if (!ui.cloudGate) return;
    ui.cloudGate.classList.remove('hidden');
    if (mode === 'syncing') {
      ui.cloudSpin.style.display = '';
      ui.cloudTitle.textContent = '正在云端同步…';
      ui.cloudMsg.textContent = '正在获取控制台设置，请稍候。';
      ui.cloudActions.classList.remove('show');
    } else {
      ui.cloudSpin.style.display = 'none';
      ui.cloudTitle.textContent = '无法连接云端';
      ui.cloudMsg.textContent = '拉取不到控制台设置，可能没有网络。要用本机当前的设置直接开始测试吗？';
      ui.cloudActions.classList.add('show');
    }
  }

  function hideCloudGate() { if (ui.cloudGate) ui.cloudGate.classList.add('hidden'); }

  // 「开始测试」的统一入口：先同步，同步不到再问。
  async function startWithCloudSync() {
    if (S.busy || S.startPending) return;
    if (!S.connected) return;
    if (S.phase === 'RUN' || S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'PAUSE') return;
    if (S.consoleConfigDirty) {
      hideCloudGate();
      if (ui.consoleStatus) {
        ui.consoleStatus.textContent = '本次测试使用刚修改的本机参数；保存到云端后才会同步到其他页面或设备。';
      }
      await beginFormalSession();
      return;
    }
    S.startPending = true;
    refreshButtons();
    try {
      showCloudGate('syncing');
      const cfg = await fetchConsoleConfig();
      if (S.consoleConfigDirty) { hideCloudGate(); await beginFormalSession(); return; }
      if (cfg) { applyConsoleConfig(cfg); hideCloudGate(); await beginFormalSession(); return; }
      showCloudGate('offline');
    } finally { S.startPending = false; refreshButtons(); }
  }

  if (ui.cloudStart) ui.cloudStart.onclick = () => { hideCloudGate(); beginFormalSession(); };
  if (ui.cloudCancel) ui.cloudCancel.onclick = hideCloudGate;

  // ------------------------------------------------------------------
  // 设备显示内容（OLED 第 3、4 行的文字或图片）
  // ------------------------------------------------------------------
  // 以前每次都要在控制台手点「发送到设备」。现在连上就自动推一次，
  // 操作者不用管，设备开机连上就能显示该显示的东西。
  //
  // 取值顺序：云端配置 -> 本机缓存 -> 默认文字。
  // 只有「渲染不出任何有效位图」时才不发（那种情况下发出去反而会刷白屏幕）。
  const DISPLAY_CACHE_KEY = 'blink-display-v1';
  // 云端和缓存都没有时的兜底。固件里 g_oled_text_bitmap 是全零数组，
  // 开机第 3、4 行本来就是空白 —— 什么都不发的话屏幕永远空着。
  const DEFAULT_DISPLAY_TEXT = '眨眼采集';
  const OLED_BITMAP_BYTES = 512;                       // 128×32 / 8
  const OLED_BITMAP_HEX_LEN = OLED_BITMAP_BYTES * 2;   // 1024 个 hex 字符

  function isValidDisplayHex(hex) {
    return typeof hex === 'string' && hex.length === OLED_BITMAP_HEX_LEN && /^[0-9a-fA-F]+$/.test(hex);
  }

  function readCachedDisplay() {
    try {
      const v = JSON.parse(localStorage.getItem(DISPLAY_CACHE_KEY) || 'null');
      return (v && typeof v === 'object') ? v : null;
    } catch (_) { return null; }
  }

  function cacheDisplay(text, bitmapHex) {
    try {
      localStorage.setItem(DISPLAY_CACHE_KEY, JSON.stringify({
        text: typeof text === 'string' ? text : '',
        bitmapHex: bitmapHex || '',
        updatedAt: Date.now()
      }));
    } catch (_) { /* 存不下不影响显示，下次再取云端 */ }
  }

  // 连上设备后自动推一次。返回是否真的发了。
  async function autoPushDisplay() {
    if (!S.connected || !S.writeFn) return false;

    let disp = null;
    try {
      const cfg = await fetchConsoleConfig();
      if (cfg) {
        const text = typeof cfg.oledText === 'string' ? cfg.oledText : '';
        const hex = isValidDisplayHex(cfg.oledBitmap) ? cfg.oledBitmap : '';
        if (text || hex) disp = { text, bitmapHex: hex };
      }
    } catch (_) { /* 没网就走缓存 */ }

    if (!disp) disp = readCachedDisplay();
    // 兜底到默认文字。这里刻意不是「什么都没有就不发」——
    // 那样虽然不会刷白屏幕，但也永远不显示，等于这个功能没做。
    if (!disp) disp = { text: DEFAULT_DISPLAY_TEXT, bitmapHex: '' };

    let hex = isValidDisplayHex(disp.bitmapHex) ? disp.bitmapHex : '';
    if (!hex && disp.text) {
      // 云端只存了文字（例如刚换设备还没选过图）——在本机渲染成位图
      try { hex = bytesToHex(renderOledText(disp.text)); } catch (_) { hex = ''; }
    }
    if (!isValidDisplayHex(hex)) return false;

    cacheDisplay(disp.text, hex);
    return queueBleText('T,' + hex + '\n');
  }


  const CONSOLE_SESSION_KEY = 'blink-console-auth-v1';
  const CONSOLE_SESSION_TTL_MS = 30 * 60 * 1000;
  let consoleLoginFailures = 0, consoleLoginBlockedUntil = 0;

  function consoleSessionValid() {
    try {
      const raw = sessionStorage.getItem(CONSOLE_SESSION_KEY);
      if (!raw) return false;
      const v = JSON.parse(raw);
      return v && Number.isFinite(v.expiresAt) && Date.now() < v.expiresAt;
    } catch (_) { return false; }
  }

  function showConsole(statusText) {
    S.consoleAuthenticated = true;
    ui.loginGate.classList.add('hidden');
    openDebugPanel();
    if (statusText && ui.consoleStatus) ui.consoleStatus.textContent = statusText;
    refreshButtons();
  }

  function showLogin(message) {
    stopReplay();
    S.consoleAuthenticated = false;
    lockDebugPanel('');
    ui.loginGate.classList.remove('hidden');
    ui.loginError.textContent = message || '';
    if (ui.loginPass) ui.loginPass.value = '';
  }

  // 成功 true / 密码错 false / 网络问题抛异常
  async function verifyConsolePassword(pass) {
    if (!await loadFirebase()) throw new Error('无法连接云端，请检查网络后重试。');
    if (!window.firebase.apps || !window.firebase.apps.length) window.firebase.initializeApp(FIREBASE_CONFIG);
    const snap = await withTimeout(
      window.firebase.database().ref('admin_auth/' + pass).once('value'), CLOUD_SYNC_TIMEOUT_MS);
    return snap.exists() && snap.val() === true;
  }

  async function submitConsoleLogin() {
    if (!ui.loginPass) return;
    if (Date.now() < consoleLoginBlockedUntil) {
      ui.loginError.textContent = '尝试过多，请 ' + Math.ceil((consoleLoginBlockedUntil - Date.now()) / 1000) + ' 秒后重试。';
      return;
    }
    const pass = ui.loginPass.value.trim();
    if (!pass) { ui.loginError.textContent = '请输入密码。'; return; }
    if (pass.length > 128 || /[.#$/[]]/.test(pass)) { ui.loginError.textContent = '密码格式不合法。'; return; }
    ui.loginBtn.disabled = true; ui.loginError.textContent = '正在校验…';
    try {
      if (await verifyConsolePassword(pass)) {
        consoleLoginFailures = 0;
        try { sessionStorage.setItem(CONSOLE_SESSION_KEY, JSON.stringify({ expiresAt: Date.now() + CONSOLE_SESSION_TTL_MS })); } catch (_) {}
        showConsole('已登录。改完记得点「保存到云端」。');
        loadConsoleConfigFromCloud().catch(() => {});
        return;
      }
      consoleLoginFailures++;
      if (consoleLoginFailures >= 5) consoleLoginBlockedUntil = Date.now() + 60000;
      ui.loginError.textContent = '密码不对。' + (consoleLoginFailures >= 5 ? '尝试过多，请 60 秒后重试。' : '');
      ui.loginPass.value = '';
    } catch (err) {
      ui.loginError.textContent = (err && err.message) || '校验失败，请重试。';
    } finally { ui.loginBtn.disabled = false; }
  }

  function consoleLogout() {
    try { sessionStorage.removeItem(CONSOLE_SESSION_KEY); } catch (_) {}
    showLogin('已退出。');
  }

  // ------------------------------------------------------------------
  // 控制台配置的上传 / 下载
  // ------------------------------------------------------------------
  // 当前应该显示在位图。默认文字；点过「发送图片到设备」之后就是图片。
  function consoleDisplayHex() {
    try {
      if (S.displayMode === 'cloud' && isValidDisplayHex(S.cloudDisplayHex)) return S.cloudDisplayHex;
      if (S.displayMode === 'image' && S.oledImageBitmap) return bytesToHex(S.oledImageBitmap);
      return bytesToHex(renderOledText(ui.oledText.value));
    } catch (_) { return ''; }
  }

  function consolePayload() {
    const c = currentConfig();
    return {
      noiseMultiplier: c.noiseMultiplier,
      refractoryMs: c.refractoryMs,
      manualThresholdEnabled: !!c.manualThresholdEnabled,
      manualDropCounts: c.manualDropCounts,
      minDropCounts: c.minDropCounts,
      blinkCalEnabled: c.blinkCalEnabled, blinkCalRatio: c.blinkCalRatio,
      oledText: ui.oledText && typeof ui.oledText.value === 'string' ? ui.oledText.value : '',
      // 位图也一起存：测试页连上设备时直接发它，不用在测量页重新渲染。
      oledBitmap: consoleDisplayHex(),
      updatedAt: Date.now(),
      updatedBy: 'test.html'
    };
  }

  async function saveConsoleConfigToCloud() {
    const payload = consolePayload();
    if (!await loadFirebase()) throw new Error('无法连接云端，请检查网络。');
    if (!window.firebase.apps || !window.firebase.apps.length) window.firebase.initializeApp(FIREBASE_CONFIG);
    await withTimeout(window.firebase.database().ref(CONSOLE_CONFIG_PATH).set(payload), CLOUD_SYNC_TIMEOUT_MS);
    return payload;
  }

  async function loadConsoleConfigFromCloud() {
    if (['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase)) throw new Error('请先结束本次测试再读取参数。');
    const before = detectorConfigFingerprint(currentConfig());
    const displayRevision = S.displayRevision;
    const cfg = await fetchConsoleConfig();
    if (!cfg) throw new Error('云端没有配置，或读不到。');
    if (['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase) || before !== detectorConfigFingerprint(currentConfig()) || displayRevision !== S.displayRevision) {
      throw new Error('读取期间本机参数或测试状态发生变化，已保留本机设置。');
    }
    applyConsoleConfig(cfg);
    return cfg;
  }

  if (ui.loginBtn) ui.loginBtn.onclick = () => { submitConsoleLogin().catch(err => console.error(err)); };
  if (ui.loginPass) ui.loginPass.onkeydown = e => { if (e.key === 'Enter') submitConsoleLogin().catch(err => console.error(err)); };
  if (ui.btnConsoleLogout) ui.btnConsoleLogout.onclick = consoleLogout;
  if (ui.btnConsoleSave) ui.btnConsoleSave.onclick = () => {
    ui.consoleStatus.textContent = '正在保存…';
    saveConsoleConfigToCloud().then(p => {
      const t = new Date(p.updatedAt).toLocaleTimeString();
      S.consoleConfigDirty = detectorConfigFingerprint(currentConfig()) !== detectorConfigFingerprint(p);
      ui.consoleStatus.textContent = '已保存到云端（' + t + '）：等级 ' + p.noiseMultiplier
        + '、间隔 ' + p.refractoryMs + ' ms、下限 ' + p.minDropCounts
        + '、手动 ' + (p.manualThresholdEnabled ? p.manualDropCounts : '关')
        + '、方案C ' + (p.blinkCalEnabled ? ('开 ' + p.blinkCalRatio) : '关') + '。'
        + (S.consoleConfigDirty ? '保存期间参数又有改动，当前值尚未同步。' : '');
    }).catch(err => { ui.consoleStatus.textContent = '保存失败：' + ((err && err.message) || err) + '。本机设置未因此回退；若低于 5 ADC 或等级低于 1，旧云端校验规则可能拒绝，不能视为已同步。'; });
  };
  if (ui.btnConsoleLoad) ui.btnConsoleLoad.onclick = () => {
    ui.consoleStatus.textContent = '正在读取…';
    loadConsoleConfigFromCloud().then(cfg => {
      ui.consoleStatus.textContent = '已从云端读取：等级 ' + cfg.noiseMultiplier
        + '、间隔 ' + cfg.refractoryMs + ' ms、下限 ' + ui.fMinDrop.value
        + '、手动 ' + (ui.manualThresholdEnabled.checked ? ui.manualDrop.value : '关')
        + '、方案C ' + (ui.fBlinkCal.checked ? ('开 ' + ui.fBlinkCalRatio.value) : '关') + '。';
    }).catch(err => { ui.consoleStatus.textContent = '读取失败：' + ((err && err.message) || err); });
  };

  // 进来就先看有没有还没过期的登录会话
  if (isConsolePage) { if (consoleSessionValid()) showConsole(''); else showLogin(''); }


  async function beginFormalSession() {
    if (S.busy) return;
    if (!S.connected) return;
    if (S.phase === 'RUN' || S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'PAUSE') return;
    stopReplay();
    S.busy = true; refreshButtons();
    try {
      await openDb();
      await S.writeChain;
      S.writeError = null;
      resetFilter();
      S.phase = 'CAL'; S.cal = []; S.calStartMs = null;
      setBlinkCount(0); S.shownBpm = 0; ui.mBpm.textContent = '0 次';
      S.events = []; S.inBlink = false; S.refractoryUntil = 0;
      S.rec = { t: [], raw: [], filt: [], ev: [] }; S.recStartMs = 0; S.recEndMs = 0;
      S.currentChunk = null; S.chunkIndex = 0; S.nextEventId = 1; S.activeSegment = null;
      S.viewingHistory = false; S.recordingStartedAt = performance.now(); S.timeoutHandling = false; S.disconnectPending = false;
      S.lastT = 0; S.lastSampleAt = 0;
      S.baseline = 0; S.mad = 0; S.noise = 1; S.dropCounts = 0; S.thDown = 0; S.thUp = 0;
      S.range.center = null; S.range.half = CFG.adcMax / 2;
      S.quality = { received: 0, saturatedLow: 0, saturatedHigh: 0 };
      S.clock = { anchorTimeline: null, anchorUtc: null, lastWallOffset: null };
      S.session = {
        id: newId(), schema: 'blink-collector/v1', status: 'recording',
        created_utc_ms: Date.now(), created_utc_iso: iso(Date.now()),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '', timezone_offset_minutes: -new Date().getTimezoneOffset(),
        participant_id: ui.subjectId.value.trim(), device_id: ui.deviceId.value.trim(), operator_id: ui.operatorId.value.trim(), condition: ui.condition.value.trim(),
        bluetooth_name: S.device && S.device.name ? S.device.name : '', bluetooth_id: S.device && S.device.id ? S.device.id : '',
        protocol: 'pending', time_source: 'phone_clock_anchor + device_elapsed_ms_when_available', config: currentConfig(), anchors: [], segments: [], quality: {}, detector: null
      };
      lockSessionInputs(true);
      setState('准备中', 'warnc');
      ui.help.textContent = '正在准备测试：请睁眼、尽量保持自然状态，约 3 秒后开始计数。';
      await persistSession();
      /* 立即给设备一个有效的 0/min，避免 Rate 一直停留在 --。 */
      pushStats();
      refreshButtons();
    } catch (err) {
      S.phase = 'STOPPED'; lockSessionInputs(false); refreshButtons();
      console.error(err); alert(`无法开始测试：${err.message || err}`);
    } finally {
      S.busy = false; refreshButtons();
      // BLINKCAL 也要算进来：beginFormalSession 里有 await，这期间样本照常到达，
      // finishCalibration 可能已经把阶段推到 BLINKCAL 了。漏掉它就漏掉断连处理。
      if (S.disconnectPending && S.session && (S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'RUN' || S.phase === 'PAUSE')) {
        S.disconnectPending = false;
        stopSession('bluetooth_disconnected').catch(console.error);
      }
    }
  }

  // ------------------------------------------------------------------
  // 现场眨眼标定（方案 C）
  // ------------------------------------------------------------------
  // 为什么需要：只靠噪声推算阈值，在信号干净时会过于保守 ——
  // 实测某段 σ=1.00，阈值却被手动定成 12（=12σ），而噪声最大才到 4σ，
  // 于是"人眼看得见、机器检不出"。这一步直接量这次这个受试者真实的眨眼有多深。
  //
  // 四条设计约束：
  //   1. 标定期间用【更灵敏】的临时阈值 —— 否则连浅眨眼都量不到，标定就白做了
  //   2. 候选还要过宽度关（>=blinkCalMinWidthMs）—— 临时阈值调低后窄脉冲也会越线
  //   3. 去掉最大的 20% 再取最小值 —— 避免一次特别大的眨眼或深呼吸把阈值定得过低
  //   4. 记不到足够次数就【自动退回】噪声法 —— 绝不能让流程卡住等在那里
  function startBlinkCalibration() {
    const config = S.session ? S.session.config : currentConfig();
    S.phase = 'BLINKCAL';
    S.blinkCal = { depths: [], startMs: S.lastT };
    S.inBlink = false;
    S.refractoryUntil = S.lastT + config.refractoryMs;
    // 临时阈值不高于旧版 6 / 2.5σ；现场调低下限或倍数时同步降低。
    const provisional = Math.max(Math.min(CFG.blinkCalProvisionalFloor, config.minDropCounts), S.noise * Math.min(CFG.blinkCalProvisionalSigma, config.noiseMultiplier));
    S.dropCounts = provisional;
    S.thDown = S.baseline - provisional;
    S.thUp = S.baseline - provisional * config.releaseRatio;
    setState('眨眼标定', 'warnc');
    updateBlinkCalPrompt();
    refreshButtons();
  }

  function updateBlinkCalPrompt() {
    const got = S.blinkCal.depths.length;
    ui.help.textContent = `请让受试者正常眨眼 ${CFG.blinkCalTarget} 次（已记录 ${got}/${CFG.blinkCalTarget}）。`
      + `用真实眨眼深度来定阈值，浅的眨眼才不会被漏掉；不眨也没关系，${Math.round(CFG.blinkCalMaxMs / 1000)} 秒后自动按噪声定。`;
  }

  function finishBlinkCal(reason) {
    const config = S.session ? S.session.config : currentConfig();
    const d = S.blinkCal.depths.slice().sort((a, b) => a - b);
    const n = d.length;
    let drop, note;
    if (n >= CFG.blinkCalMinAccepted) {
      // 取第 20 百分位，而不是"直接取最小值"。
      // 原因：候选里可能混进一个恰好很浅的伪迹（宽度关只是降低概率，不是消灭）。
      // 一旦最小值被它拉低，阈值就崩了 → 满屏误检，比漏检更难收拾。
      // 取第 20 百分位等价于"忽略最小的那 1 个"，抗单个离群点，代价只是稍微保守一点。
      const idx = Math.min(n - 1, Math.floor(n * 0.2));
      const minDepth = d[idx];
      const fromBlink = minDepth * config.blinkCalRatio;
      const fromNoise = S.noise * config.noiseMultiplier;
      // ⚠️ 这里刻意【不】带 CFG.minDropCounts：带上它阈值就永远降不到 minDropCounts
      //    以下，而"能降下去"正是这个功能存在的理由。
      //    噪声倍数由现场设置决定，不再暗中固定为 4σ。
      drop = Math.max(fromBlink, fromNoise);
      note = `眨眼标定完成：记录 ${n} 次，参考深度 ${minDepth}（第20百分位）；深度法 ${Math.round(fromBlink)}、`
           + `噪声下限 ${Math.round(fromNoise)} → 阈值取 ${Math.round(drop)}`;
    } else {
      drop = Math.max(config.minDropCounts, S.noise * config.noiseMultiplier);
      note = `眨眼标定只记录到 ${n} 次（需要 ${CFG.blinkCalMinAccepted} 次），已退回按噪声定阈值 ${Math.round(drop)}`;
    }
    S.dropCounts = drop;
    S.thDown = S.baseline - drop;
    S.thUp = S.baseline - drop * config.releaseRatio;
    S.inBlink = false;
    S.refractoryUntil = S.lastT + config.refractoryMs;
    S.phase = 'RUN';
    if (S.session) {
      S.session.blink_calibration = {
        enabled: true, reason: reason || 'done', depths: d, accepted: n,
        threshold: drop, noise_sigma: S.noise, note,
        start_timeline_ms: S.blinkCal.startMs, end_timeline_ms: S.lastT,
        run_baseline: S.baseline, refractory_until_ms: S.refractoryUntil
      };
      if (S.session.detector) {
        S.session.initial_detector = { ...S.session.detector };
        Object.assign(S.session.detector, { baseline: S.baseline, drop_counts: drop, threshold_down: S.thDown, threshold_up: S.thUp });
      }
      addEvent('blink_calibration_done', S.lastT, sampleUtc(S.lastT, Date.now()),
               { accepted: n, threshold: Math.round(drop), reason: reason || 'done' });
      persistSession();
    }
    setState('计数中', 'good');
    ui.help.textContent = note + '。测试中：黄色竖线表示已识别的眨眼。';
    updateDebugControls();
    refreshButtons();
  }

  function finishCalibration() {
    const config = S.session ? S.session.config : currentConfig();
    const base = median(S.cal);
    const calMin = S.cal.length ? Math.min(...S.cal) : 0;
    const calMax = S.cal.length ? Math.max(...S.cal) : 0;
    const railSamples = S.cal.filter(v => v <= 8 || v >= CFG.adcMax - 8).length;
    const calibrationInvalid = S.cal.length < CFG.sampleRateHz || base <= 8 || base >= CFG.adcMax - 8 || railSamples / Math.max(1, S.cal.length) > 0.05;
    if (calibrationInvalid) {
      S.quality.calibration_valid = false;
      S.quality.calibration_samples = S.cal.length;
      S.quality.calibration_min = calMin;
      S.quality.calibration_max = calMax;
      S.phase = 'STOPPED'; S.inBlink = false;
      if (S.session) {
        S.session.status = 'calibration_invalid';
        S.session.ended_utc_ms = Date.now(); S.session.ended_utc_iso = iso(S.session.ended_utc_ms);
        S.session.quality = { ...S.quality };
        addEvent('calibration_invalid', S.lastT, sampleUtc(S.lastT, Date.now()), { baseline: base, min: calMin, max: calMax });
        persistSession().catch(console.error);
      }
      lockSessionInputs(false); setState('信号异常', 'badc'); refreshButtons();
      ui.help.textContent = '准备阶段信号异常或接近量程边界，本次测试已停止，请检查佩戴、传感器和连接后重新测试。';
      return;
    }
    // rawMad / sigmaRaw 只留档做对比；真正参与判定的是去漂移后的 sigma。
    const mad = median(S.cal.map(v => Math.abs(v - base)));
    const sigmaRaw = Math.max(1, 1.4826 * mad);
    const sigma = robustNoise(S.cal);
    const drift = calibrationDrift(S.cal);
    const drop = config.manualThresholdEnabled
      ? Math.max(config.minDropCounts, config.manualDropCounts)
      : Math.max(config.minDropCounts, sigma * config.noiseMultiplier);

      S.baseline = base;
    S.mad = mad; S.noise = sigma; S.dropCounts = drop;
    S.quality.calibration_valid = true;
    S.quality.calibration_samples = S.cal.length;
    S.quality.calibration_min = Math.min(...S.cal);
    S.quality.calibration_max = Math.max(...S.cal);
    S.thDown = base - drop;
    S.thUp = base - drop * config.releaseRatio;
    S.phase = 'RUN';
    if (S.session) {
      S.session.detector = { baseline: base, mad, sigma, sigma_raw: sigmaRaw, drift_counts: Math.round(drift), drop_counts: drop, threshold_down: S.thDown, threshold_up: S.thUp, calibrated_timeline_ms: S.lastT };
      addEvent('calibration_complete', S.lastT, sampleUtc(S.lastT, Date.now()));
      persistSession();
    }
    setState('计数中', 'good');
    ui.help.innerHTML = '测试中：黄色竖线表示已识别的眨眼。若波形明显异常，请结束本次测试后重新开始。';
    refreshButtons();
    // 电极漂移的现场提示。比事后看数据有用得多 —— 在医院当场就能处理。
    if (Math.abs(drift) >= CFG.calibrationDriftWarnCounts) {
      ui.help.textContent = '⚠️ 电极似乎在漂移：标定 ' + (CFG.calibrationMs / 1000).toFixed(0) + ' 秒内基线'
        + (drift > 0 ? '上移' : '下移') + '了 ' + Math.abs(drift).toFixed(0) + ' counts。'
        + '这会把阈值抬高、漏掉浅眨眼。建议重新贴电极、让受试者放松不动，或稍等 1 分钟重新开始。';
      setState('电极漂移', 'warnc');
      if (S.session) {
        addEvent('electrode_drift_warning', S.lastT, sampleUtc(S.lastT, Date.now()),
                 { drift_counts: Math.round(drift), sigma, sigma_raw: sigmaRaw });
      }
    }
    // 方案 C：噪声法标定完，若开启了现场眨眼标定，再量一次受试者真实的眨眼深度。
    // 注意是【之后】调用 —— 上面那套噪声法结果已经落进 S.session.detector，两条路都留痕。
    if (config.blinkCalEnabled) startBlinkCalibration();
    if (!ui.debugPanel.classList.contains('hidden')) {
      updateDebugControls();
    }
  }

  function detect(t, filt) {
    const config = S.session ? S.session.config : currentConfig();
    const refr = config.refractoryMs;

    if (!S.inBlink) {
      if (filt < S.thDown && t >= S.refractoryUntil) {
        S.inBlink = true;
        S.fallingMs = t;
        S.minInBlink = filt;
      }
      // 只在非事件状态慢慢更新基线，避免眨眼把基线拖下去
      const drop = S.dropCounts || Math.max(0, S.baseline - S.thDown);
      const a = config.baselineAlpha;
      S.baseline += a * (filt - S.baseline);
      S.thDown = S.baseline - drop;
      S.thUp = S.baseline - drop * config.releaseRatio;
    } else {
      if (filt < S.minInBlink) S.minInBlink = filt;
      const width = t - S.fallingMs;

      if (filt > S.thUp) {
        if (width >= config.minWidthMs && width <= config.maxWidthMs) {
          const amp = Math.round(S.baseline - S.minInBlink);
          if (S.phase === 'BLINKCAL') {
            // 现场眨眼标定：只记深度，不计入正式计数、不写事件。
            // 宽度再卡一道 —— 临时阈值调低了，窄脉冲噪声也会越过它。
            if (width >= CFG.blinkCalMinWidthMs) {
              S.blinkCal.depths.push(amp);
              updateBlinkCalPrompt();
              if (S.blinkCal.depths.length >= CFG.blinkCalTarget) {
                S.refractoryUntil = t + refr; S.inBlink = false;
                finishBlinkCal('target_reached');
                return;
              }
            }
          } else {
            setBlinkCount(S.count + 1);
            const ev = { t: S.fallingMs, utcMs: sampleUtc(S.fallingMs, Date.now()), amp, width };
            S.events.push(ev);
            if (S.events.length > CFG.maxEvents) S.events.shift();
            S.rec.ev.push(ev);
            addEvent('blink', ev.t, ev.utcMs, { amplitude_counts: ev.amp, width_ms: width, algorithm: 'web-live-v1' });
            ui.mLast.textContent = `${width.toFixed(0)} ms / ${ev.amp}`;
            updateLiveStats(t);
            pushStats();             // 事件写入后再同步，避免设备端落后一次眨眼
          }
        }
        S.refractoryUntil = t + refr;
        S.inBlink = false;
      } else if (width > config.maxWidthMs) {
        S.inBlink = false;                 // 太宽，判为伪迹丢弃
        S.refractoryUntil = t + refr;
      }
    }
    /* 注意：千万不要在这里（每个采样点都跑）刷新屏幕或下发统计。
       detect() 是 200Hz 调用的，在这里写 DOM / 发蓝牙会让下行涨到 2.4 kB/s。
       屏幕刷新只在 setBlinkCount() 里做，下发只在眨眼那一刻和 500ms tick 做。 */
  }

  function recentBlinkCount(nowMs) {
    if (!Number.isFinite(nowMs)) return 0;
    const win = CFG.realtimeWindowMs;
    const from = nowMs - win;
    let n = 0;
    for (let i = S.events.length - 1; i >= 0; i--) {
      if (S.events[i].t >= from) n++; else break;
    }
    return n;
  }

  function realtimeBpm(nowMs) {
    const n = recentBlinkCount(nowMs);
    if (n === 0) return 0;
    const win = CFG.realtimeWindowMs;
    const from = nowMs - win;
    if (n === 0) return 0;
    const activeMs = S.session
      ? activeDurationMs(S.session, from, nowMs)
      : Math.min(win, Math.max(1000, nowMs - (S.recStartMs || 0)));
    if (activeMs < 1000) return null;
    return Math.round(n / activeMs * 60000);
  }

  // 设备时间轴与 performance.now() 同一坐标系；在两个蓝牙通知之间
  // 用最近一个采样点向前估计，避免实时卡片必须等下一包或按“暂停”才刷新。
  function liveTimelineNow() {
    if (!Number.isFinite(S.lastT)) return performance.now();
    if (!S.lastSampleAt) return S.lastT;
    return S.lastT + Math.max(0, performance.now() - S.lastSampleAt);
  }

  function updateLiveStats(nowMs = liveTimelineNow()) {
    if (!S.session || !Number.isFinite(nowMs)) return;
    const n = recentBlinkCount(nowMs);
    ui.mBpm.textContent = `${n} 次`;
    S.shownBpm = realtimeBpm(nowMs);
  }

  // ------------------------------------------------------------------
  // 采样入口
  // ------------------------------------------------------------------
  function sampleUtc(t, receivedUtcMs) {
    if (!S.session) return receivedUtcMs;
    const wallOffset = receivedUtcMs - performance.now();
    if (S.clock.anchorTimeline === null) {
      S.clock.anchorTimeline = t; S.clock.anchorUtc = receivedUtcMs; S.clock.lastWallOffset = wallOffset;
      S.session.anchors.push({ timeline_ms: t, phone_utc_ms: receivedUtcMs, phone_utc_iso: iso(receivedUtcMs), reason: 'first_recorded_sample' });
    } else if (Math.abs(wallOffset - S.clock.lastWallOffset) > 1000) {
      S.clock.anchorTimeline = t; S.clock.anchorUtc = receivedUtcMs; S.clock.lastWallOffset = wallOffset;
      S.session.anchors.push({ timeline_ms: t, phone_utc_ms: receivedUtcMs, phone_utc_iso: iso(receivedUtcMs), reason: 'phone_clock_changed' });
      addEvent('phone_clock_changed', t, receivedUtcMs, { note: '手机系统时钟变化超过 1 秒；此处建立新的时间锚点。' });
    } else {
      S.clock.lastWallOffset = wallOffset;
    }
    return S.clock.anchorUtc + (t - S.clock.anchorTimeline);
  }

  function updateQuality(raw) {
    const q = S.quality;
    let flags = 0;
    q.received++;
    if (raw <= 2) { q.saturatedLow++; flags |= 2; }
    if (raw >= CFG.adcMax - 2) { q.saturatedHigh++; flags |= 4; }
    return flags;
  }

  function appendRecordedSample(t, utcMs, receivedUtcMs, raw, filt, flags) {
    if (!S.session) return;
    beginSegment(t, utcMs);
    if (!S.currentChunk) {
      S.currentChunk = { sessionId: S.session.id, index: S.chunkIndex++, start_timeline_ms: t, start_utc_ms: utcMs, rows: [] };
    }
    S.currentChunk.rows.push([t, utcMs, receivedUtcMs, raw, Math.round(filt), S.activeSegment ? S.activeSegment.id : 0, flags]);
    S.session.first_timeline_ms ??= t; S.session.first_utc_ms ??= utcMs;
    S.session.last_timeline_ms = t; S.session.last_utc_ms = utcMs;
    if (S.currentChunk.rows.length >= CHUNK_SAMPLES) {
      flushChunk().catch(console.error);
      persistSession().catch(console.error);
    }
  }

  function onSample(t, raw, filtFromDevice) {
    if (S.viewingHistory && S.phase === 'STOPPED') return;
    if (!Number.isFinite(t) || !Number.isFinite(raw) || raw < 0 || raw > CFG.adcMax) return;
    S.lastT = t; S.lastSampleAt = performance.now();

    const filt = Number.isFinite(filtFromDevice) ? filtFromDevice : pushMA(raw);
    if (Number.isFinite(filtFromDevice)) pushMA(raw); // 保持滤波器状态连续

    const receivedUtcMs = Date.now();
    const recording = S.session && (S.phase === 'RUN' || S.phase === 'CAL' || S.phase === 'BLINKCAL');
    const utcMs = recording ? sampleUtc(t, receivedUtcMs) : receivedUtcMs;
    const flags = recording ? updateQuality(raw) | (S.phase === 'BLINKCAL' ? 8 : 0) : 0;
    if (recording) appendRecordedSample(t, utcMs, receivedUtcMs, raw, filt, flags);

    S.samples.push({ t, raw, filt });
    if (S.samples.length > 4000) S.samples.shift();

    if (S.phase === 'CAL') {
      if (S.calStartMs === null) S.calStartMs = t;
      // 点「开始测试」的瞬间，蓝牙开始收发会在波形开头打出一个尖峰。
      // 这个尖峰一旦进了标定样本，MAD 会被抬高 → 判决阈值跟着被撑大 → 后面真实的眨眼反而检不出来。
      // 所以开头 calibrationSkipMs 内的样本不进标定窗口；标定总时长不变，只是可用样本往后顺延。
      if (t - S.calStartMs >= CFG.calibrationSkipMs) S.cal.push(filt);
      if (t - S.calStartMs >= CFG.calibrationMs) finishCalibration();
    } else if (S.phase === 'RUN') {
      detect(t, filt);
    } else if (S.phase === 'BLINKCAL') {
      detect(t, filt);
      // detect 里可能已经因为收够次数而切到 RUN 了，所以再看一眼当前阶段
      if (S.phase === 'BLINKCAL' && S.blinkCal.startMs !== null &&
          t - S.blinkCal.startMs >= CFG.blinkCalMaxMs) finishBlinkCal('timeout');
    }
  }

  // ------------------------------------------------------------------
  // 协议解析（兼容三种帧）
  // ------------------------------------------------------------------
  function onChunk(text) {
    S.rx += text;
    if (S.rx.length > 32768) {
      S.rx = '';
      if (S.session && (S.phase === 'CAL' || S.phase === 'RUN')) {
        S.quality.discontinuities = (S.quality.discontinuities || 0) + 1;
        addEvent('rx_buffer_overflow', S.lastT, sampleUtc(S.lastT, Date.now()), { note: '接收缓存超过限制，部分帧被丢弃。' });
        resetFilter(); S.inBlink = false;
      }
    }
    const parts = S.rx.split('\n');
    S.rx = parts.pop();
    for (const line of parts) parseLine(line);
  }

  // ------------------------------------------------------------------
  // 设备时间轴：用单片机的采样时间戳，而不是通知的到达时刻
  // ------------------------------------------------------------------
  // ⚠️ 这件事非做不可，原因是固件的发送是**突发式**的：
  //    固件每 80ms 攒够 16 个样本（DMA 半块）才打包，
  //    304 字节在 115200 下连续吐 26.4ms，然后静默 53.6ms。
  //    所以「到达时刻」不是「采样时刻」：
  //      · 同一块的 16 个点会拿到几乎相同的时刻，块与块之间空 54ms
  //      · 示波器在相邻点间隔 > 12ms 时断线 → 波形被画成一串 1px 短划
  //      · detect() 的 width = t - fallingMs 会被量化到约 80ms，不可靠
  //    固件本来就发了采样时刻（帧里的第 3 个字段），用它就没有这些问题，
  //    时间轴变成严格 5ms 等间隔，与滤波器的采样计数假设一致。
  //
  //    代价：这套映射只在 4 字段帧（D,seq,t_ms,raw）上可用。
  //    如果哪天把固件的 FRAME_FULL 改成 0（发 D,raw），就退回到到达时刻，
  //    上面的三个问题会全部回来 —— 所以 FRAME_FULL 必须保持 1。
  //
  // 比较相邻帧；正常 uint32 回绕连续推进，重启则分段并保持时间单调。
  function breakSampleContinuity(reason, details = {}) {
    if (S.session && ['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase)) {
      endSegment(S.lastT, sampleUtc(S.lastT, Date.now()));
      S.quality.discontinuities = (S.quality.discontinuities || 0) + 1;
      S.quality.missingSamples = (S.quality.missingSamples || 0) + (details.missing || 0);
      addEvent(reason, S.lastT, sampleUtc(S.lastT, Date.now()), details);
      ui.help.textContent = '检测到数据中断，本次记录已标记，请结束后重新测试。';
    }
    resetFilter(); S.inBlink = false;
    S.refractoryUntil = S.lastT + CFG.refractoryMs;
    if (S.phase === 'CAL') { S.cal = []; S.calStartMs = null; }
  }

  function deviceTimeline(mcuMs, seq) {
    const d = S.dev;
    const valid = v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
    if (!valid(mcuMs) || !valid(seq)) return NaN;
    const period = 1000 / CFG.sampleRateHz;
    if (d.lastMcu === null) {
      d.lastMcu = mcuMs; d.lastSeq = seq; d.lastPage = performance.now();
      return d.lastPage;
    }
    const dt = (mcuMs - d.lastMcu) >>> 0;
    const ds = (seq - d.lastSeq) >>> 0;
    if (dt === 0 && ds === 0) return NaN; // 重复帧不重复计数
    const reset = dt === 0 || dt >= 0x80000000 || ds === 0 || ds >= 0x80000000;
    if (reset) {
      breakSampleContinuity('device_timeline_resync', { previous_ms: d.lastMcu, device_ms: mcuMs });
      d.lastPage = Math.max(performance.now(), d.lastPage + period);
    } else {
      if (ds !== 1 || Math.abs(dt - period) > 2) {
        breakSampleContinuity('sample_gap', { missing: Math.max(ds - 1, Math.round(dt / period) - 1, 0), delta_ms: dt });
      }
      d.lastPage += dt;
    }
    d.lastMcu = mcuMs; d.lastSeq = seq;
    return d.lastPage;
  }

  function parseLine(line) {
    const s = line.trim();
    if (!s) return;
    if (s.startsWith('DBG,')) return; // Ignore unsolicited legacy diagnostics; never used for access.
    if (consumeOtaReply(s)) return;
    const p = s.split(',');
    if (p[0] === 'B') {
      if (S.session && (S.phase === 'RUN' || S.phase === 'PAUSE' || S.phase === 'CAL')) {
        addEvent('physical_button', S.lastT, sampleUtc(S.lastT, Date.now()));
      }
      return;
    }
    const phoneTimelineMs = performance.now();
    if (p.length === 1 && /^\d+$/.test(p[0])) {
      if (S.session) S.session.protocol = 'raw (arrival time only)';
      onSample(phoneTimelineMs, +p[0]);
      return;
    }
    if (p[0] !== 'D') return;

    if (p.length === 2) {
      if (!/^\d+$/.test(p[1])) { breakSampleContinuity('invalid_frame'); return; }
      if (S.session) S.session.protocol = 'D,raw (arrival time only)';
      // 正式格式：D,raw；没有采样时间戳，只能用到达时刻（见 deviceTimeline 的说明）
      onSample(phoneTimelineMs, +p[1]);
    } else if (p.length === 4) {
      // 当前固件 D,seq,t_ms,raw：★ 用 p[2] 的采样时刻建时间轴 ★
      // （这一分支必须走 deviceTimeline，否则波形会断成点线）
      // 损坏的正式帧丢弃并留痕，不能伪装成使用到达时间的有效采样。
      if (!p.slice(1).every(v => /^\d+$/.test(v)) || +p[3] > CFG.adcMax) {
        breakSampleContinuity('invalid_frame'); return;
      }
      if (S.session) S.session.protocol = 'D,seq,t_ms,raw';
      onSample(deviceTimeline(+p[2], +p[1]), +p[3]);
    } else if (p.length === 8) {
      // 旧固件的 8 字段格式：p[2] 是那颗固件自己的计数，时基未知，
      // 不敢当时间戳用，仍按到达时刻处理。
      onSample(phoneTimelineMs, +p[3]);
    } else if (p.length === 5) {
      onSample(phoneTimelineMs, +p[1]);
    }
  }

  // 眨眼次数的唯一出口：改 S.count 的同时刷新屏幕。
  // 这样「屏幕上的数」和「下发给设备的数」永远同源，
  // 不会出现开始一次新测试后屏幕还显示旧数字、而设备已经是 0 的情况。
  function setBlinkCount(n) {
    S.count = n;
    ui.mCount.textContent = String(n);
  }

  // ------------------------------------------------------------------
  // 下发统计给设备（OLED 镜像显示）
  // ------------------------------------------------------------------
  // ⚠️ 这里是「设备显示什么」的唯一出口。判决与统计始终只在网页里做，
  //    设备不参与任何计算，只是把这两个数拿去显示 —— HANDOFF §4 的架构不变。
  //
  //    协议：N,<本次眨眼次数>,<眨眼频率次/分>\n
  //          频率 = -1 表示网页此刻显示的是 --（还没算出来 / 不在记录中）
  //
  //    次数取 S.count，频率取 S.shownBpm —— 也就是屏幕上正在显示的那个值。
  //    两者同源，所以不会出现「网页一个频率、设备另一个频率」。
  const BLE_WRITE_CHUNK_BYTES = 20;
  // 分片之间留一点间隔：模块的 UART 只有 115200，1027 字节的 T 位图命令
  // 被瞬间灌进去会把模块的发送缓冲冲掉，单片机收到残缺命令就整条丢弃。
  // 20 字节在 115200 下只要 1.7ms，给 6ms 留约 3.5 倍余量。
  const BLE_WRITE_CHUNK_GAP_MS = 6;

  // Web Bluetooth 在未协商更大 MTU 时，单次写入通常只能容纳约 20 字节。
  // 所有下行命令都在这里顺序切片，避免 OLED 位图或统计帧互相插入。
  function queueBleBytes(bytes) {
    if (!S.connected || !S.writeFn) return Promise.resolve(false);
    const work = S.bleWriteChain.then(async () => {
      for (let i = 0; i < bytes.length; i += BLE_WRITE_CHUNK_BYTES) {
        await S.writeFn(bytes.slice(i, i + BLE_WRITE_CHUNK_BYTES));
        if (i + BLE_WRITE_CHUNK_BYTES < bytes.length && BLE_WRITE_CHUNK_GAP_MS > 0) {
          await new Promise(resolve => setTimeout(resolve, BLE_WRITE_CHUNK_GAP_MS));
        }
      }
      return true;
    });
    S.bleWriteChain = work.catch(err => { console.error('蓝牙下行失败', err); return false; });
    return work;
  }

  function queueBleText(text) {
    return queueBleBytes(new TextEncoder().encode(text));
  }

  function pushStats() {
    if (!S.connected || !S.writeFn || S.viewingHistory || S.replay) return;
    const bpm = (S.shownBpm === null || !Number.isFinite(S.shownBpm)) ? -1 : Math.round(S.shownBpm);
    const line = `N,${S.count},${bpm}\n`;

    // 500ms tick 只负责更新“最新值”。如果前面的 T 位图还在传输，
    // 不再把同一条 N 命令重复塞进 BLE/UART 队列。
    if (line === S.statsLastLine || line === S.statsQueuedLine) return;
    S.statsQueuedLine = line;
    if (S.statsWritePending) return;

    S.statsWritePending = true;
    (async () => {
      try {
        while (S.connected && S.writeFn && S.statsQueuedLine) {
          const next = S.statsQueuedLine;
          S.statsQueuedLine = '';
          if (next === S.statsLastLine) continue;
          const ok = await queueBleText(next);
          if (!ok) return;
          S.statsLastLine = next;
        }
      } finally {
        S.statsWritePending = false;
        // 在最后一次写入期间如果又产生了新统计，立即补发最新值。
        if (S.connected && S.writeFn && S.statsQueuedLine &&
            S.statsQueuedLine !== S.statsLastLine) pushStats();
      }
    })().catch(err => console.error('统计下发失败', err));
  }

  // 将 Canvas 转成 OLED SSD1306 可接受的 4 页、128×32 位图。
  // 固件会把这 4 页写到 OLED 的下半屏（物理第 3、4 行）。
  // 不能只取 R 通道：红/蓝色图片的 R 值可能很低，会在二值化时整块消失。
  function canvasToOledBitmap(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = ctx.getImageData(0, 0, 128, 32).data;
    const bitmap = new Uint8Array(128 * 4);
    for (let page = 0; page < 4; page++) {
      for (let x = 0; x < 128; x++) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) {
          const y = page * 8 + bit;
          const i = (y * 128 + x) * 4;
          const alpha = pixels[i + 3] / 255;
          const luma = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) * alpha;
          if (luma >= 96) value |= 1 << bit;
        }
        bitmap[page * 128 + x] = value;
      }
    }
    return bitmap;
  }

  // 将图片等比例缩放到 128×32 内，并按用户拖动的偏移绘制。
  // 输出仍然是 OLED 的 1-bit 位图，不需要单片机增加图片解码库。
  function drawOledImage(image, canvas, offsetX = 0, offsetY = 0) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 32);
    const g = getOledImageGeometry(image);
    if (!g) return;
    const dx = Math.round(g.baseX + offsetX);
    const dy = Math.round(g.baseY + offsetY);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, 128, 32); ctx.clip();
    // 保留平滑缩放后再二值化，细线比直接最近邻缩放更完整；颜色在上面统一按亮度处理。
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, dx, dy, g.dw, g.dh);
    ctx.restore();
  }

  function renderOledImage(image) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 32;
    drawOledImage(image, canvas);
    return canvasToOledBitmap(canvas);
  }

  // 将手机上的两行文字绘制成 OLED SSD1306 的 128×32 位图。
  // 自定义文字使用 OLED 的物理第 3、4 行，共 4 页、512 字节；
  // 第 1、2 行留给固件显示统计。STM32 不需要中文字库，网页使用手机已有的字体渲染。
  function renderOledText(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 32);
    ctx.fillStyle = '#fff';
    ctx.font = '16px "PingFang SC", "Hiragino Sans GB", sans-serif';
    ctx.textBaseline = 'top';
    const lines = [[]];
    const normalized = String(text || '').replace(/\r\n?/g, '\n');
    for (const ch of Array.from(normalized)) {
      if (ch === '\n') {
        if (lines.length < 2) lines.push([]);
        continue;
      }
      let line = lines[lines.length - 1];
      if (line.length >= 8) {
        if (lines.length >= 2) break;
        lines.push([]);
        line = lines[lines.length - 1];
      }
      line.push(ch);
    }
    while (lines.length < 2) lines.push([]);

    // OLED 每行是 128 像素，按 16×16 字格绘制：每行严格 8 格。
    // 这样不依赖手机当前字体的实际宽度，中文不会挤成 5 个字，
    // 第二行也一定会参与位图生成；超宽回退字形会缩放到格内。
    for (let row = 0; row < 2; row++) {
      const line = Array.isArray(lines[row]) ? lines[row] : [];
      for (let col = 0; col < line.length && col < 8; col++) {
        const ch = line[col];
        const x = col * 16, y = row * 16;
        const width = Math.max(1, ctx.measureText(ch).width);
        const scale = Math.min(1, 16 / width);
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, 16, 16); ctx.clip();
        ctx.translate(x, y); ctx.scale(scale, scale); ctx.fillText(ch, 0, 0);
        ctx.restore();
      }
    }

    return canvasToOledBitmap(canvas);
  }

  function bytesToHex(bytes) {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0').toUpperCase();
    return out;
  }

  // ------------------------------------------------------------------
  // OTA：Intel HEX 解析、分包与 ACK 重传
  // ------------------------------------------------------------------
  // STM32F103C8 按 64KiB 规划：Bootloader 8KiB，应用从 0x08002000 开始，
  // 应用可用 24KiB。网页只允许上传应用区 HEX，避免误把完整 HEX 覆盖 Bootloader。
  const OTA_APP_BASE = 0x08002000;
  const OTA_APP_END = 0x08008000;
  const OTA_PACKET_BYTES = 32;

  function hexBytes(text, label) {
    const s = text.trim();
    if (!s || (s.length & 1) || !/^[0-9a-f]+$/i.test(s)) throw new Error(`${label}不是有效十六进制`);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function parseIntelHex(text) {
    const image = new Uint8Array(OTA_APP_END - OTA_APP_BASE);
    image.fill(0xff);
    let upper = 0;
    let minAddress = Infinity, maxAddress = -Infinity, eof = false;
    const lines = String(text).replace(/\r/g, '').split('\n');

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo].trim();
      if (!line) continue;
      if (eof) throw new Error(`HEX 第 ${lineNo + 1} 行出现在结束记录之后`);
      if (!line.startsWith(':') || ((line.length - 1) & 1)) throw new Error(`HEX 第 ${lineNo + 1} 行格式错误`);
      const record = hexBytes(line.slice(1), `HEX 第 ${lineNo + 1} 行`);
      if (record.length < 5 || record.length !== record[0] + 5) throw new Error(`HEX 第 ${lineNo + 1} 行长度错误`);
      let sum = 0; for (const byte of record) sum = (sum + byte) & 0xff;
      if (sum !== 0) throw new Error(`HEX 第 ${lineNo + 1} 行校验和错误`);

      const length = record[0];
      const address = (record[1] << 8) | record[2];
      const type = record[3];
      if (type === 0x00) {
        const absolute = upper + address;
        if (absolute < OTA_APP_BASE || absolute + length > OTA_APP_END) {
          throw new Error(`HEX 第 ${lineNo + 1} 行地址超出应用区，请使用从 0x08002000 链接的应用 HEX`);
        }
        for (let i = 0; i < length; i++) {
          const index = absolute - OTA_APP_BASE + i;
          if (image[index] !== 0xff && image[index] !== record[4 + i]) {
            throw new Error(`HEX 第 ${lineNo + 1} 行与已有数据冲突`);
          }
          image[index] = record[4 + i];
        }
        minAddress = Math.min(minAddress, absolute);
        maxAddress = Math.max(maxAddress, absolute + length);
      } else if (type === 0x01) {
        if (length !== 0) throw new Error(`HEX 第 ${lineNo + 1} 行结束记录错误`);
        eof = true;
      } else if (type === 0x04) {
        if (length !== 2) throw new Error(`HEX 第 ${lineNo + 1} 行扩展地址错误`);
        upper = ((record[4] << 8) | record[5]) << 16;
      } else if (type === 0x02) {
        if (length !== 2) throw new Error(`HEX 第 ${lineNo + 1} 行段地址错误`);
        upper = ((record[4] << 8) | record[5]) << 4;
      } else if (type === 0x03 || type === 0x05) {
        // 启动地址记录对 Cortex-M3 的裸机应用没有作用，合法但忽略。
      } else {
        throw new Error(`HEX 第 ${lineNo + 1} 行包含不支持的记录类型`);
      }
    }
    if (!eof) throw new Error('HEX 缺少结束记录');
    if (minAddress !== OTA_APP_BASE || maxAddress <= OTA_APP_BASE) {
      throw new Error('HEX 不是从 0x08002000 开始的 OTA 应用文件，请在 Keil 中重新生成应用 HEX。');
    }
    const size = maxAddress - OTA_APP_BASE;
    return { image: image.slice(0, size), size, crc32: crc32Bytes(image, size) };
  }

  function crc32Bytes(bytes, length = bytes.length) {
    let crc = 0xffffffff;
    for (let i = 0; i < length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
    return (~crc) >>> 0;
  }

  function crc16Ccitt(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  function rejectOtaWaiter(error) {
    const waiter = S.ota.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    S.ota.waiter = null;
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  function consumeOtaReply(line) {
    if (!line.startsWith('OTA,')) return false;
    const waiter = S.ota.waiter;
    if (!waiter) return true;
    clearTimeout(waiter.timer);
    S.ota.waiter = null;
    const parts = line.split(',');
    if (parts[1] === 'ERR') waiter.reject(new Error(`设备拒绝 OTA：${parts.slice(2).join(',') || '未知错误'}`));
    else waiter.resolve(parts);
    return true;
  }

  function waitOtaReply(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (S.ota.waiter) { reject(new Error('OTA 协议状态异常')); return; }
      const timer = setTimeout(() => {
        if (S.ota.waiter && S.ota.waiter.timer === timer) S.ota.waiter = null;
        reject(new Error('等待设备 OTA 应答超时'));
      }, timeoutMs);
      S.ota.waiter = { resolve, reject, timer };
    });
  }

 async function sendOtaCommand(command) {
   if (!S.connected || !S.writeFn) throw new Error('蓝牙已断开');
    // 连接后可能还在发送 OLED 文字/图片位图。必须先等已有 BLE
    // 写入队列排空，再启动应答计时，否则命令尚未真正发出就会超时。
    await S.bleWriteChain;
    if (!S.connected || !S.writeFn) throw new Error('蓝牙已断开');
    const reply = waitOtaReply().then(value => ({value}), error => ({error}));
    try {
      const sent = await queueBleText(`${command}\n`);
      if (!sent) rejectOtaWaiter(new Error('蓝牙写入失败'));
    } catch (err) { rejectOtaWaiter(err); }
    const result = await reply;
    if (result.error) throw result.error;
    return result.value;
  }

  async function runOta() {
    if (!S.connected || !S.writeFn) throw new Error('请先连接采集设备');
    if (['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase)) throw new Error('请先结束当前测试');
    const file = ui.otaFile.files && ui.otaFile.files[0];
    if (!file) throw new Error('请先选择应用 HEX 文件');

    S.busy = true; S.ota.running = true; refreshButtons();
    try {
      ui.otaStatus.textContent = '正在读取并校验 HEX…';
      const firmware = parseIntelHex(await file.text());
      ui.otaStatus.textContent = `文件有效：${firmware.size} 字节，正在等待蓝牙发送队列完成…`;
     const begin = await sendOtaCommand(`OTA_BEGIN,${firmware.size},${firmware.crc32},1`);
     if (begin[1] !== 'BEGIN' || begin[2] !== 'OK') throw new Error('设备未确认 OTA 开始');
      ui.otaStatus.textContent = `暂存区已准备好，正在上传固件：0%（0/${firmware.size} 字节）`;

      for (let offset = 0; offset < firmware.size; offset += OTA_PACKET_BYTES) {
        const chunk = firmware.image.slice(offset, Math.min(offset + OTA_PACKET_BYTES, firmware.size));
        const command = `OTA_DATA,${offset},${bytesToHex(chunk)},${crc16Ccitt(chunk)}`;
        let accepted = false, lastErr = null;
        for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
          // ⚠️ 异常也要当成"一次失败"来重试。以前 await 一旦抛（丢应答超时最常见），
          //    会直接冒泡出去把整个升级中止，3 次重试形同虚设 —— 而 BLE 丢一个应答并不罕见。
          try {
            const ack = await sendOtaCommand(command);
            accepted = ack[1] === 'ACK' && Number(ack[2]) === offset + chunk.length;
            if (!accepted) lastErr = new Error(`设备回了意外应答：${ack.join(',')}`);
          } catch (err) {
            lastErr = err;
          }
          if (!accepted) {
            if (!S.connected || !S.writeFn) break;          // 真断链了就别白试
            if (attempt < 2) await new Promise(r => setTimeout(r, 120));
          }
        }
        if (!accepted) throw lastErr || new Error(`数据包 ${offset} 未获设备确认`);
        const percent = Math.round(((offset + chunk.length) / firmware.size) * 100);
        ui.otaStatus.textContent = `正在上传固件：${percent}%（${offset + chunk.length}/${firmware.size} 字节）`;
      }

      const end = await sendOtaCommand('OTA_END');
      if (end[1] !== 'END' || end[2] !== 'OK') throw new Error('设备未通过完整性校验');
      const reboot = await sendOtaCommand('OTA_REBOOT');
      if (reboot[1] !== 'REBOOTING') throw new Error('设备未进入重启升级');
      ui.otaStatus.textContent = '升级文件已接收，设备正在重启并覆盖应用区；完成后请重新连接。';
    } finally {
      S.ota.running = false; S.busy = false; refreshButtons();
    }
  }

  ui.otaFile.onchange = () => {
    const file = ui.otaFile.files && ui.otaFile.files[0];
    ui.otaStatus.textContent = file ? `已选择：${file.name}，等待上传。` : '未选择升级文件。';
    refreshButtons();
  };
  ui.btnOta.onclick = () => {
    runOta().catch(error => {
      console.error(error);
      ui.otaStatus.textContent = `升级失败：${error.message || error}。若设备不再输出采样，请复位设备后重新连接；仅重新连接可能无法恢复采样。`;
      alert(`OTA 升级失败：${error.message || error}`);
    });
  };

  async function sendOledText(silent = false) {
    if (!S.connected || !S.writeFn) {
      if (!silent) setConnText('请先连接采集设备，再发送屏幕文字。', false);
      return false;
    }
    saveOledText();
    const bitmap = renderOledText(ui.oledText.value);
    if (!silent) setConnText('采集设备已连接，屏幕文字发送中…', true);
    const ok = await queueBleText(`T,${bytesToHex(bitmap)}\n`);
    if (ok) {
      S.displayMode = 'text'; S.displayRevision++;
      cacheDisplay(ui.oledText.value, bytesToHex(bitmap));
    }
    if (!silent && ok) setConnText('采集设备已连接，屏幕文字已更新。', true);
    return ok;
  }
  ui.btnOledSend.onclick = () => { sendOledText(false).catch(console.error); };

  async function sendOledImage(silent = false) {
    if (!S.connected || !S.writeFn) {
      if (!silent) setConnText('请先连接采集设备，再发送屏幕图片。', false);
      return false;
    }
    if (!S.oledImageBitmap) {
      if (!silent) ui.oledImageStatus.textContent = '请先选择并处理一张图片。';
      return false;
    }
    if (!silent) setConnText('采集设备已连接，屏幕图片发送中…', true);
    const ok = await queueBleText(`T,${bytesToHex(S.oledImageBitmap)}\n`);
    if (ok) {
      S.displayMode = 'image'; S.displayRevision++;
      cacheDisplay(ui.oledText.value, bytesToHex(S.oledImageBitmap));
    }
    if (!silent && ok) {
      setConnText('采集设备已连接，屏幕图片已更新。', true);
      ui.oledImageStatus.textContent = `已发送：${S.oledImageName || '图片'}。`;
    }
    return ok;
  }
  ui.btnOledImageSend.onclick = () => { sendOledImage(false).catch(console.error); };

  // ------------------------------------------------------------------
  // BLE
  // ------------------------------------------------------------------
  async function connect() {
    if (!navigator.bluetooth) {
      alert('当前浏览器无法连接采集设备。');
      return;
    }
    try {
      setConnText('选择蓝牙设备…');
      S.device = await navigator.bluetooth.requestDevice({
        // 不用 service filter：部分 BLE 设备不会在广播包里声明 GATT
        // Service UUID，使用 filter 会让浏览器选择框直接显示为空。
        // 这里允许用户看到附近设备，再由后面的 GATT 服务检查确认
        // 是否为本采集模块。
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID, 0xfff0]
      });
      S.device.addEventListener('gattserverdisconnected', onDisconnected);
      const server = await S.device.gatt.connect();
      let service;
      try { service = await server.getPrimaryService(SERVICE_UUID); }
      catch (err) {
        if (err.name !== 'NotFoundError') throw err;
        service = await server.getPrimaryService(0xfff0);
      }
      const chars = await service.getCharacteristics();
      const selected = selectBleChannels(service.uuid, chars);
      S.notifyChar = selected.notify; S.writeChar = selected.write;
      // 两种写入方式要分开选：只支持 writeWithoutResponse 的模块上，
      // 直接调 writeValue() 会抛 NotSupportedError。
      S.writeFn = !S.writeChar ? null
                : (S.writeChar.properties.write
                    ? (b) => S.writeChar.writeValueWithResponse
                      ? S.writeChar.writeValueWithResponse(b)
                      : S.writeChar.writeValue(b)
                    : (b) => S.writeChar.writeValueWithoutResponse(b));
      if (!S.notifyChar) throw new Error('这个服务下没有可通知的特征');

      S.rx = ''; S.dev = { lastMcu: null, lastPage: null, lastSeq: null }; S.bleWriteChain = Promise.resolve();
      S.statsLastLine = ''; S.statsQueuedLine = '';
      S.notifyChar.addEventListener('characteristicvaluechanged',
        e => onChunk(new TextDecoder().decode(e.target.value)));
      await S.notifyChar.startNotifications();

      S.connected = true;
     ui.btnConn.textContent = '断开设备';
     const deviceName = (S.device.name || '').trim();
     const genericName = !deviceName || /^(bt|ble|bluetooth)$/i.test(deviceName);
     setConnText(`采集设备已连接${genericName ? '' : `（${deviceName}）`}，可以开始准备测试。`, true);
     refreshButtons();
      // 先发一条短的有效统计，再发送可能持续数秒的 128×32 位图。
      // 这样现有固件也能在刚连接时显示 Rate: 0/min，不必等图片传完或按暂停。
      if (!S.session && S.shownBpm === null) S.shownBpm = 0;
      pushStats();
     // 连上就把云端（或本机缓存）里的文字/图片推下去；
     // 拿不到内容时 autoPushDisplay() 什么都不做，不会刷白屏幕。
     autoPushDisplay().catch(console.error);
    } catch (err) {
      console.error(err);
      if (S.device && S.device.gatt.connected) S.device.gatt.disconnect();
      S.notifyChar = null; S.writeChar = null; S.writeFn = null;
      const detail = err.message || String(err);
      const notOurDevice = S.device && /getPrimaryService|服务|service/i.test(detail);
      setConnText(notOurDevice
        ? '连接失败：所选设备不是采集模块（请选择 VG6328A-MS）'
        : `连接失败：${detail}`);
      S.connected = false;
      refreshButtons();
    }
  }

  function selectBleChannels(serviceUuid, chars) {
    const uuid = n => `0000${n}-0000-1000-8000-00805f9b34fb`;
    const byId = id => chars.find(c => c.uuid.toLowerCase() === uuid(id));
    const notifies = c => c && (c.properties.notify || c.properties.indicate);
    const writes = c => c && (c.properties.write || c.properties.writeWithoutResponse);
    const ebyte = serviceUuid.toLowerCase() === uuid('fff0');
    let notify = byId(ebyte ? 'fff1' : 'ffe2');
    let write = byId(ebyte ? 'fff2' : 'ffe1');
    if (!notifies(notify) && !ebyte) {
      // 兼容现有 KT：只有一个明确的通知通道时才允许回退。
      const candidates = chars.filter(notifies);
      notify = candidates.length === 1 ? candidates[0] : null;
    }
    if (!writes(write) && !ebyte) {
      const candidates = chars.filter(writes);
      write = candidates.length === 1 ? candidates[0] : null;
    }
    if (!notifies(notify)) throw new Error('无法确定设备的数据接收通道，请检查设备配置。');
    return { notify, write: writes(write) ? write : null };
  }

  function onDisconnected() {
    rejectOtaWaiter(new Error('蓝牙连接在 OTA 过程中断开'));
    S.connected = false;
    S.notifyChar = null; S.writeChar = null; S.writeFn = null; S.rx = ''; S.bleWriteChain = Promise.resolve();
    S.statsLastLine = ''; S.statsQueuedLine = '';
    ui.btnConn.textContent = '连接设备';
    setConnText('设备已断开');
    if (S.phase === 'RUN' || S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'PAUSE') {
      S.disconnectPending = true;
      if (!S.busy) {
        S.disconnectPending = false;
        stopSession('bluetooth_disconnected').catch(console.error);
      }
    }
    refreshButtons();
  }

  ui.btnConn.onclick = () => {
    if (S.connected && S.device && S.device.gatt.connected) S.device.gatt.disconnect();
    else connect();
  };

  // ------------------------------------------------------------------
  // 按钮
  // ------------------------------------------------------------------
  ui.btnStart.onclick = () => { startWithCloudSync().catch(err => { console.error(err); hideCloudGate(); }); };
  ui.btnPause.onclick = () => {
    if (S.busy || !S.session) return;
    if (S.phase === 'RUN') {
      const utcMs = sampleUtc(S.lastT, Date.now());
      endSegment(S.lastT, utcMs); addEvent('pause', S.lastT, utcMs); persistSession();
      S.phase = 'PAUSE'; setState('已暂停', 'warnc');
    } else if (S.phase === 'PAUSE') {
      resetFilter(); S.inBlink = false;
      S.recordingStartedAt = performance.now(); S.lastSampleAt = 0;
      S.refractoryUntil = S.lastT + (S.session ? S.session.config.refractoryMs : CFG.refractoryMs);
      addEvent('resume', S.lastT, sampleUtc(S.lastT, Date.now()));
      S.phase = 'RUN'; setState('计数中', 'good');
    }
    refreshButtons();
  };
  async function stopSession(reason = 'user_stop') {
    if (!S.session || (S.busy && reason !== 'data_timeout')) return;
    S.busy = true; refreshButtons();
    try {
    const utcMs = sampleUtc(S.lastT, Date.now());
    endSegment(S.lastT, utcMs); addEvent(reason, S.lastT, utcMs);
    S.phase = 'STOPPED'; S.inBlink = false; S.session.status = reason;
    S.session.ended_utc_ms = utcMs; S.session.ended_utc_iso = iso(utcMs); S.session.quality = { ...S.quality };
    await persistSession(); await waitForWrites();
    if (reason === 'data_timeout' || reason === 'bluetooth_disconnected') {
      S.shownBpm = null; ui.mBpm.textContent = '--';
    }
    pushStats();
    lockSessionInputs(false);
    setState('已停止', 'badc');
    ui.help.textContent = S.quality.discontinuities
      ? '本次记录存在数据中断，建议重新测试。可以导出数据用于检查。'
      : '测试已结束并保存在本机。请点击“导出数据”保存本次测试文件。';
    fillRangeInputs();
    refreshButtons();
    analyze().catch(console.error);
    refreshSessionList();
    } finally { S.busy = false; refreshButtons(); }
  }
  ui.btnStop.onclick = () => { stopSession().catch(console.error); };
  ui.btnClear.onclick = () => {
    if (S.busy || S.phase === 'RUN' || S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'PAUSE') return;
    stopReplay();
    setBlinkCount(0); S.events = []; S.samples = []; S.session = null; S.currentChunk = null;
    S.viewingHistory = false; S.writeError = null; S.recordingStartedAt = 0;
    S.rec = { t: [], raw: [], filt: [], ev: [] }; S.recStartMs = 0; S.recEndMs = 0; S.phase = 'IDLE';
    lockSessionInputs(false);
    ui.mBpm.textContent = '--'; ui.mLast.textContent = '--';
    S.shownBpm = null; pushStats();      // 清屏也要同步给设备，否则设备还停在旧数字上
    ui.fT0.value = 0; ui.fT1.value = 0;
    clearSummary();
    setState('待机', 'badc');
    ui.help.innerHTML = '当前显示已清除；已保存到本机数据库的历史记录不会被删除。';
    refreshButtons();
  };
  // ------------------------------------------------------------------
  // 离线分析：自选区间内按固定窗口滑窗统计频率
  // ------------------------------------------------------------------
  function clearSummary() {
    ui.sAvg.textContent = '--'; ui.sCount.textContent = '--';
    ui.sDur.textContent = '--'; ui.sWin.textContent = '--';
  }

  function fillRangeInputs() {
    if (!S.session || !Number.isFinite(S.session.first_timeline_ms) || !Number.isFinite(S.session.last_timeline_ms)) return;
    const t0 = S.session.first_timeline_ms, t1 = S.session.last_timeline_ms;
    ui.fT0.value = 0;
    ui.fT1.value = Math.round((t1 - t0) / 1000);
  }

  ui.btnFull.onclick = () => { if (!S.busy) { fillRangeInputs(); analyze().catch(console.error); } };
  ui.btnAnalyze.onclick = () => { if (!S.busy) analyze().catch(console.error); };

  // fixedDrop：这次会话实时判决时真正用过的阈值。传了就【直接用它】，不再自己重算 ——
  // 方案 C（现场眨眼标定）定出来的阈值是量出来的，离线这条路上没有眨眼标定那一段数据，
  // 重算必然对不上，同一份记录「实时」和「回看」就会给出不同的眨眼数。
  function makeOfflineDetector(config, fixedDrop, blinkCalibration = null) {
    let ma = [], maSum = 0, cal = [], calStart = null, baseline = 0, thDown = 0, thUp = 0;
    let ready = false, inBlink = false, falling = 0, fallingUtc = 0, minimum = 0, refractoryUntil = 0, previousSegment = null;
    const push = v => { ma.push(v); maSum += v; if (ma.length > config.maLength) maSum -= ma.shift(); return maSum / ma.length; };
    return row => {
      const [t, utcMs,, raw,, segment] = row;
      if (previousSegment !== null && segment !== previousSegment) {
        ma = []; maSum = 0; inBlink = false; refractoryUntil = t + config.refractoryMs;
        if (!ready) { cal = []; calStart = null; }
      }
      previousSegment = segment;
      const filt = push(raw);
      // New records retain the complete Plan C waveform and the exact state at
      // the transition to formal counting. Replay the filter but exclude those
      // calibration blinks, then restore the same baseline and refractory time.
      // 守卫必须覆盖这段代码**实际用到的每一个**字段。少验一个的后果不是报错，是静默出错：
      //   refractory_until_ms 缺失 → refractoryUntil = undefined → `t >= undefined` 恒假
      //                             → 一次眨眼都判不出来，而且不报警；
      //   threshold 缺失 + fixedDrop 非有限 → drop = undefined → thDown = NaN，同上。
      // 两者都退回常规标定路径（不是静默 0 次）。
      if (!ready && blinkCalibration
          && Number.isFinite(blinkCalibration.end_timeline_ms)
          && Number.isFinite(blinkCalibration.run_baseline)
          && Number.isFinite(blinkCalibration.refractory_until_ms)) {
        if (t <= blinkCalibration.end_timeline_ms) return null;
        const drop = Number.isFinite(fixedDrop) ? fixedDrop : blinkCalibration.threshold;
        if (Number.isFinite(drop)) {
          baseline = blinkCalibration.run_baseline;
          thDown = baseline - drop; thUp = baseline - drop * config.releaseRatio;
          refractoryUntil = blinkCalibration.refractory_until_ms;
          ready = true;
        }
      }
      if (calStart === null) calStart = t;
      if (!ready) {
        // 必须和实时判决用同一个标定窗口：开头 calibrationSkipMs 的样本同样不进标定。
        // 否则同一份数据「实时」和「回看」会算出不同的眨眼数 —— 这是数据一致性问题。
        // 旧记录里没有这个字段，取 0，它们的行为和以前完全一样。
        const skipMs = Number(config.calibrationSkipMs) || 0;
        if (t - calStart >= skipMs) cal.push(filt);
        if (t - calStart < config.calibrationMs) return null;
        const base = median(cal);
        // 阈值优先用「实时当时真正用过的那个」（现场眨眼标定 / 手动 / 噪声法都算）。
        // 只有拿不到时才退回自己重算 —— 而且重算也必须用和实时同一套噪声估计（去漂移），
        // 否则同一份数据「实时」和「回看」会算出不同的眨眼数。
        const sigma = robustNoise(cal);
        const drop = Number.isFinite(fixedDrop)
          ? fixedDrop
          : (config.manualThresholdEnabled
              ? Math.max(config.minDropCounts, config.manualDropCounts)
              : Math.max(config.minDropCounts, sigma * config.noiseMultiplier));
        baseline = base; thDown = base - drop; thUp = base - drop * config.releaseRatio; ready = true;
        return null;
      }
      if (!inBlink) {
        if (filt < thDown && t >= refractoryUntil) { inBlink = true; falling = t; fallingUtc = utcMs; minimum = filt; }
        const drop = baseline - thDown;
        baseline += config.baselineAlpha * (filt - baseline);
        thDown = baseline - drop; thUp = baseline - drop * config.releaseRatio;
        return null;
      }
      minimum = Math.min(minimum, filt);
      const width = t - falling;
      if (filt > thUp || width > config.maxWidthMs) {
        inBlink = false; refractoryUntil = t + config.refractoryMs;
        if (width >= config.minWidthMs && width <= config.maxWidthMs) return { t: falling, utcMs: fallingUtc, width, amp: Math.round(baseline - minimum) };
      }
      return null;
    };
  }

  async function analyze() {
    const canvas = $('freq');
    const ctx = canvas.getContext('2d');
    const wrap = $('freqWrap');
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(wrap.clientWidth * dpr);
    canvas.height = Math.round(wrap.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = wrap.clientWidth, H = wrap.clientHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#050b13'; ctx.fillRect(0, 0, W, H);

    if (!S.session || !Number.isFinite(S.session.first_timeline_ms)) { clearSummary(); return; }

    await waitForWrites();
    const t0rec = S.session.first_timeline_ms, t1rec = S.session.last_timeline_ms;
    const totalSec = (t1rec - t0rec) / 1000;
    let a = Number(ui.fT0.value) || 0;
    let b = Number(ui.fT1.value) || Math.round(totalSec);
    a = clamp(a, 0, totalSec); b = clamp(b, 0, totalSec);
    if (b <= a) { clearSummary(); ui.help.textContent = '查看区间的结束时间必须大于开始时间。'; return; }

    const winMs = clamp((Number(ui.fWin.value) || 30) * 1000, 5000, 600000);
    const stepMs = clamp((Number(ui.fStep.value) || 5) * 1000, 1000, 600000);

    // 把这次会话实时判决时真正用过的阈值取出来传下去。
    // blink_calibration.threshold 在"深度法"和"退回噪声法"两条分支里都会写，
    // 所以它总是等于实时实际用的那个值。
    const liveDrop = S.session.blink_calibration && Number.isFinite(S.session.blink_calibration.threshold)
      ? S.session.blink_calibration.threshold
      : (S.session.detector && Number.isFinite(S.session.detector.drop_counts) ? S.session.detector.drop_counts : null);
    const detector = makeOfflineDetector(S.session.config, liveDrop, S.session.blink_calibration);
    const allEvents = [];
    await visitChunks(S.session.id, chunk => {
      for (const row of chunk.rows) { const event = detector(row); if (event) allEvents.push(event); }
    });
    const from = t0rec + a * 1000, to = t0rec + b * 1000;
    const ev = allEvents.filter(e => e.t >= from && e.t <= to);
    const span = to - from;

    // 滑窗
    const series = [];
    if (span <= winMs) {
      const activeMs = activeDurationMs(S.session, from, to);
      series.push({ t: from + span / 2, bpm: activeMs >= 1000 ? ev.length / (activeMs / 1000) * 60 : null, n: ev.length });
    } else {
      for (let w = from; w + winMs <= to + 1; w += stepMs) {
        const n = ev.filter(e => e.t >= w && e.t < w + winMs).length;
        const activeMs = activeDurationMs(S.session, w, w + winMs);
        series.push({ t: w + winMs / 2, bpm: activeMs >= 1000 ? n / (activeMs / 1000) * 60 : null, n });
      }
    }

    // 坐标
    const padL = 42, padR = 10, padT = 14, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxBpm = Math.max(20, ...series.map(s => Number.isFinite(s.bpm) ? s.bpm : 0));
    const x = t => padL + (span <= 0 ? 0 : (t - from) / span) * plotW;
    const y = v => padT + plotH - (v / maxBpm) * plotH;

    // 网格
    ctx.strokeStyle = '#18304a'; ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace'; ctx.fillStyle = '#8ea3bd';
    for (let i = 0; i <= 4; i++) {
      const v = maxBpm * i / 4, yy = y(v);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillText(v.toFixed(0), 6, yy + 3);
    }
    ctx.fillText('次/分', 6, 10);
    ctx.fillText(`0s`, padL, H - 6);
    ctx.fillText(`${(span / 1000).toFixed(0)}s`, padL + plotW - 30, H - 6);

    // 曲线
    if (series.length) {
      ctx.strokeStyle = '#38d996'; ctx.lineWidth = 2;
      ctx.beginPath();
      let pathOpen = false;
      series.forEach((s, i) => {
        if (!Number.isFinite(s.bpm)) { pathOpen = false; return; }
        const px = x(s.t), py = y(s.bpm);
        pathOpen ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        pathOpen = true;
      });
      ctx.stroke();
      ctx.fillStyle = '#38d996';
      series.filter(s => Number.isFinite(s.bpm)).forEach(s => { ctx.beginPath(); ctx.arc(x(s.t), y(s.bpm), 2.2, 0, Math.PI * 2); ctx.fill(); });
    }

    const activeMs = activeDurationMs(S.session, from, to);
    const avg = activeMs >= 1000 ? ev.length / (activeMs / 1000) * 60 : null;
    ui.sAvg.textContent = avg === null ? '--' : `${avg.toFixed(1)} 次/分`;
    ui.sCount.textContent = `${ev.length} 次`;
    ui.sDur.textContent = `${(activeMs / 1000).toFixed(1)} 秒有效采集`;
    ui.sWin.textContent = `${series.length} 个`;
  }

  // ------------------------------------------------------------------
  // 导出与本机历史记录
  // ------------------------------------------------------------------
  // 从「会话快照 + 数据库里的数据块/事件」拼出导出包。
  // 刚录完的记录和翻出来的历史记录走的是同一套校验，不会两套标准。
  // 导出前的可导性校验。抽成纯函数有两个原因：
  //   1) 这里出过 bug（阈值过严，导致加跳过之后录的每一条都导不出去）——
  //      单独拎出来才能用测试盯死
  //   2) 错误信息能带上具体数字，而不是一句笼统的"无法导出"
  // 返回 null = 可以导出；否则返回不能导出的原因。
  function exportRejectReason(snapshot) {
    if (!snapshot || !snapshot.id) return '记录无效。';
    if (snapshot.storage_error) return '这条记录保存时出过错，数据可能不完整。';
    if (snapshot.status === 'recording') return '这条记录还在进行中，请先结束测试。';
    const q = snapshot.quality || {};
    if (snapshot.status === 'calibration_invalid' || q.calibration_valid === false) {
      return '这条记录的准备阶段被判为无效。';
    }
    if (snapshot.schema === 'blink-collector/v1') {
      const need = minCalibrationSamples(snapshot.config);
      if (!Number.isFinite(q.calibration_samples)) return '这条记录没记下准备阶段的样本数。';
      if (q.calibration_samples < need) {
        return '准备阶段样本太少（只有 ' + q.calibration_samples + ' 个，至少要 ' + need + ' 个）。';
      }
    }
    return null;
  }

  async function buildBundle(sessionSnapshot) {
    const sessionId = sessionSnapshot.id;
    const reason = exportRejectReason(sessionSnapshot);
    if (reason) throw new Error(reason);
    const q = sessionSnapshot.quality || {};
    const sampleChunks = [];
    await visitChunks(sessionId, chunk => sampleChunks.push(chunk));
    const storedCount = sampleChunks.reduce((n, c) => n + c.rows.length, 0);
    const expectedCount = q.received;
    if (Number.isFinite(expectedCount) && storedCount !== expectedCount) {
      throw new Error('保存的样本数不完整（库里 ' + storedCount + ' 个，记录里 ' + expectedCount + ' 个）。');
    }
    const exportedUtcMs = Date.now();
    return {
      schema: 'blink-export/v1',
      exported_utc_ms: exportedUtcMs,
      exported_utc_iso: iso(exportedUtcMs),
      metadata: sessionSnapshot,
      event_columns: ['sessionId', 'id', 'type', 'timeline_ms', 'utc_ms', 'phone_utc_iso', 'width_ms', 'amplitude_counts', 'algorithm', 'note'],
      events: (await readEvents(sessionId)).sort((a, b) => a.id - b.id),
      sample_columns: ['phone_timeline_ms', 'sample_utc_ms', 'phone_received_utc_ms', 'adc_raw', 'adc_filtered', 'segment_id', 'flags'],
      sample_flag_bits: { saturated_low: 2, saturated_high: 4, blink_calibration: 8 },
      sample_chunks: sampleChunks
    };
  }

  async function readSessionRecord(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const r = db.transaction('sessions', 'readonly').objectStore('sessions').get(id);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }

  async function exportBundle() {
    if (!S.session || S.busy) return;
    if (S.phase === 'RUN' || S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'PAUSE') throw new Error('请先结束测试。');
    const sessionId = S.session.id;
    S.busy = true; refreshButtons();
    try {
      await waitForWrites();
      if (!S.session || S.session.id !== sessionId) throw new Error('记录已切换，已取消导出。');
      const bundle = await buildBundle(JSON.parse(JSON.stringify(S.session)));
      saveBlob(`blink-${sessionId}.json`, 'application/json;charset=utf-8', [JSON.stringify(bundle)]);
    } finally { S.busy = false; refreshButtons(); }
  }

  // 直接把「本机保存的测试」里选中的那条导出，不用先打开它。
  async function exportSelectedSession() {
    const id = ui.sessionList.value;
    if (!id) { alert('请先在下拉框里选一条记录。'); return; }
    if (S.busy || ['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase)) return;
    S.busy = true; refreshButtons();
    try {
      // 选中的可能就是正在录的那条 —— 先把在途写入落盘，再读库
      await S.writeChain;
      const rec = await readSessionRecord(id);
      if (!rec) throw new Error('本机找不到这条记录。');
      const bundle = await buildBundle(rec);
      saveBlob(`blink-${id}.json`, 'application/json;charset=utf-8', [JSON.stringify(bundle)]);
    } finally { S.busy = false; refreshButtons(); }
  }

  // 导出本机全部历史：一个文件里放所有会话的包。
  async function exportAllSessions() {
    if (S.busy || ['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase)) return;
    S.busy = true; refreshButtons();
    try {
      await S.writeChain;
      const db = await openDb();
      const all = await new Promise((resolve, reject) => {
        const r = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
        r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error);
      });
      if (!all.length) { alert('本机还没有保存任何测试。'); return; }
      // 先按记录里的样本数估个体量，让用户心里有数（全是内存里拼，太大会卡）
      const totalSamples = all.reduce((n, r) => n + ((r.quality && Number(r.quality.received)) || 0), 0);
      const estMB = (totalSamples * 60 / 1048576).toFixed(0);
      if (!confirm(`导出全部 ${all.length} 条本机测试？\n\n共约 ${totalSamples.toLocaleString()} 个采样点，文件大约 ${estMB} MB。\n生成和下载都需要一点时间，请不要中途离开页面。`)) return;

      const skipped = [];
      const exportedUtcMs = Date.now();
      const stamp = iso(exportedUtcMs).replace(/[:.]/g, '-');
      // 按块写进 Blob 的 parts，不要先拼成一个巨大的字符串 ——
      // 全部记录可能有几百 MB，拼字符串会多占一整份内存。
      const parts = ['{"schema":"blink-export-all/v1","exported_utc_ms":' + exportedUtcMs +
                     ',"exported_utc_iso":' + JSON.stringify(iso(exportedUtcMs)) + ',"sessions":['];
      let count = 0;
      for (const rec of all.slice().sort((a, b) => a.created_utc_ms - b.created_utc_ms)) {
        try {
          const bundle = await buildBundle(JSON.parse(JSON.stringify(rec)));
          parts.push(count ? ',' : '', JSON.stringify(bundle));   // 顺带把分隔符拼上
          count++;
        } catch (err) {
          skipped.push({ id: rec.id, participant_id: rec.participant_id || '', reason: err.message || String(err) });
        }
      }
      if (!count) throw new Error('没有一条能导出。' + (skipped[0] ? ' 例如：' + skipped[0].reason : ''));
      parts.push('],"session_count":' + count + ',"skipped":' + JSON.stringify(skipped) + '}');
      saveBlob(`blink-all-${stamp}.json`, 'application/json;charset=utf-8', parts);
      if (skipped.length) {
        alert(`已导出 ${count} 条；有 ${skipped.length} 条跳过，原因记在文件的 skipped 字段里。\n\n第一条：${skipped[0].reason}`);
      }
    } finally { S.busy = false; refreshButtons(); }
  }

  async function refreshSessionList() {
    try {
      const db = await openDb();
      const sessions = await new Promise((resolve, reject) => {
        const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
        request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error);
      });
      const selected = S.session ? S.session.id : ui.sessionList.value;
      ui.sessionList.textContent = '';
      sessions.sort((a, b) => b.created_utc_ms - a.created_utc_ms).forEach(s => {
        const option = document.createElement('option'); option.value = s.id;
        option.textContent = `${s.participant_id || '未命名'} · ${iso(s.created_utc_ms).replace('T', ' ').slice(0, 19)}`;
        if (s.id === selected) option.selected = true;
        ui.sessionList.append(option);
      });
    } catch (err) { console.warn(err); }
  }

  async function loadSelectedSession() {
    if (S.busy || ['CAL', 'BLINKCAL', 'RUN', 'PAUSE'].includes(S.phase)) return;
    const id = ui.sessionList.value;
    if (!id || (S.session && id === S.session.id)) return;
    stopReplay();
    S.busy = true; refreshButtons();
    try {
      const db = await openDb();
      const session = await new Promise((resolve, reject) => {
        const request = db.transaction('sessions', 'readonly').objectStore('sessions').get(id);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (!session || ui.sessionList.value !== id) return;
      await S.writeChain;
      S.session = session; S.phase = 'STOPPED'; S.viewingHistory = true; S.samples = []; S.events = []; S.currentChunk = null;
      S.timeoutHandling = false; S.recordingStartedAt = 0; S.lastSampleAt = 0;
      S.baseline = 0; S.mad = 0; S.noise = 1; S.dropCounts = 0; S.thDown = 0; S.thUp = 0;
      S.range.center = null; S.range.half = CFG.adcMax / 2;
      S.writeError = session.storage_error || null;
      const historyEvents = await readEvents(id);
      S.events = historyEvents.filter(e => e.type === 'blink').map(e => ({ t: e.timeline_ms, amp: e.amplitude_counts, width: e.width_ms }));
      setBlinkCount(S.events.length);
      await visitChunks(id, chunk => {
        for (const row of chunk.rows) S.samples.push({ t: row[0], raw: row[3], filt: row[4] });
        S.samples = S.samples.slice(-4000);
      });
      S.lastT = session.last_timeline_ms || 0;
      ui.mBpm.textContent = '--'; ui.mLast.textContent = '--'; S.shownBpm = null;
      S.quality = { ...S.quality, ...(session.quality || {}) };
      ui.subjectId.value = session.participant_id || ''; ui.deviceId.value = session.device_id || '';
      ui.operatorId.value = session.operator_id || ''; ui.condition.value = session.condition || '';
      applyConsoleConfig(session.config);
      lockSessionInputs(false); updateDebugControls(); fillRangeInputs(); setState('已载入', 'bluec'); await analyze();
    } catch (err) { console.error(err); alert(`载入失败：${err.message || err}`); }
    finally { S.busy = false; refreshButtons(); }
  }

  // Import is atomic and always allocates fresh local identifiers: never overwrite.
  function validateImport(data) {
    const bundles = data && data.schema === 'blink-export-all/v1' ? data.sessions : [data];
    if (!Array.isArray(bundles) || !bundles.length || bundles.length > 200) throw new Error('请选择本系统导出的数据文件（一次最多 200 条）。');
    const columns = ['phone_timeline_ms','sample_utc_ms','phone_received_utc_ms','adc_raw','adc_filtered','segment_id','flags'];
    let total = 0;
    for (const b of bundles) {
      const m = b && b.metadata;
      if (!b || b.schema !== 'blink-export/v1' || !m || typeof m.id !== 'string' || !m.config ||
          !Number.isFinite(m.created_utc_ms) || Math.abs(m.created_utc_ms) > 8e15 ||
          !Array.isArray(b.sample_columns) || b.sample_columns.join('|') !== columns.join('|') ||
          !Array.isArray(b.sample_chunks) || !Array.isArray(b.events)) throw new Error('文件结构或数据列不受支持。');
      if (!Number.isFinite(m.config.sampleRateHz) || m.config.sampleRateHz <= 0 || m.config.sampleRateHz > 100000) throw new Error('采样率无效。');
      for (const v of Object.values(m.config)) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('记录参数无效。');
      let last = -Infinity, count = 0;
      const indices = new Set();
      for (const c of b.sample_chunks) {
        if (!c || c.sessionId !== m.id || !Number.isInteger(c.index) || c.index < 0 || indices.has(c.index) || !Array.isArray(c.rows)) throw new Error('数据块编号或归属无效。');
        indices.add(c.index);
      }
      for (const c of b.sample_chunks.slice().sort((a,b)=>a.index-b.index)) for (const row of c.rows) {
        if (!Array.isArray(row) || row.length !== 7 || !row.every(Number.isFinite) || row[0] < last ||
            Math.abs(row[1]) > 8e15 || Math.abs(row[2]) > 8e15 || row[3] < 0 || row[3] > CFG.adcMax ||
            !Number.isInteger(row[5]) || !Number.isInteger(row[6])) throw new Error('采样点无效或时间顺序错误。');
        last = row[0]; count++; total++;
        if (total > 500000) throw new Error('一次最多导入 50 万个采样点，请拆分文件。');
      }
      if (!count || !Number.isFinite(m.quality?.received) || count !== m.quality.received) throw new Error('样本数量不完整，未导入任何记录。');
      if (!Number.isFinite(m.first_timeline_ms) || !Number.isFinite(m.last_timeline_ms) || m.last_timeline_ms < m.first_timeline_ms) throw new Error('记录时间范围无效。');
      const ids = new Set();
      for (const ev of b.events) {
        if (!ev || ev.sessionId !== m.id || !Number.isInteger(ev.id) || ids.has(ev.id) || typeof ev.type !== 'string' ||
            !Number.isFinite(ev.timeline_ms) || !Number.isFinite(ev.utc_ms)) throw new Error('事件数据无效。');
        ids.add(ev.id);
      }
    }
    return bundles;
  }

  async function importData(data) {
    if (!isConsolePage || !S.consoleAuthenticated || !consoleSessionValid()) throw new Error('请在控制台登录后导入数据。');
    if (S.busy || S.startPending || ['CAL','BLINKCAL','RUN','PAUSE'].includes(S.phase)) throw new Error('请先结束当前测试。');
    const bundles = validateImport(data);
    S.busy = true; refreshButtons(); stopReplay();
    try {
      await waitForWrites();
      const db = await openDb();
      const ids = [];
      await new Promise((resolve,reject)=>{
        const tx = db.transaction(['sessions','chunks','events'],'readwrite');
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = ()=>reject(tx.error || new Error('导入失败，已回滚。'));
        try {
          for (const b of bundles) {
            const id = newId(); ids.push(id);
            tx.objectStore('sessions').add({...b.metadata,id,import_source_id:b.metadata.id,imported_utc_ms:Date.now()});
            for (const c of b.sample_chunks) tx.objectStore('chunks').add({...c,sessionId:id});
            for (const ev of b.events) tx.objectStore('events').add({...ev,sessionId:id});
          }
        } catch(err) { tx.abort(); reject(err); }
      });
      await refreshSessionList(); ui.sessionList.value = ids[0];
      ui.help.textContent = `已导入 ${ids.length} 条数据，原始时间戳未改变。请选择记录并打开；不会覆盖已有记录。`;
      return ids;
    } finally { S.busy = false; refreshButtons(); }
  }

  function stopReplay() {
    S.replay = null;
    document.body.classList.remove('replay-focused');
    for(const id of ['trialDrop','trialRefractory','trialReset','trialExport']){const el=document.getElementById(id);if(el)el.disabled=true;}
    const trialStatus=document.getElementById('trialStatus');if(trialStatus)trialStatus.textContent='先开始重放再试调。未导出的试调结果不会保存；原始数据不受影响。';
    const originalConfig=document.getElementById('originalReplayConfig');if(originalConfig)originalConfig.textContent='';
    const label = document.getElementById('replayStatus');
    if (label) label.textContent = '重放仅查看已保存波形与原始事件，不改写数据。';
    const button = document.getElementById('btnReplay');
    if (button) button.textContent = '开始重放';
    for(const id of ['btnReplayStop','replaySeek']) {
      const control=document.getElementById(id);if(control)control.disabled=true;
    }
  }
  function seekReplay(ms) {
    const r = S.replay; if (!r) return;
    r.position = clamp(ms, r.start, r.end); r.wall = performance.now();
    let lo=0, hi=r.rows.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(r.rows[mid][0]<=r.position)lo=mid+1;else hi=mid;}
    r.visible = r.rows.slice(Math.max(0,lo-4000),lo).map(row=>({t:row[0],raw:row[3],filt:row[4]}));
    const row=r.rows[Math.max(0,lo-1)];
    document.getElementById('replaySeek').value = String(r.position-r.start);
    document.getElementById('replayStatus').textContent = `${((r.position-r.start)/1000).toFixed(1)} / ${((r.end-r.start)/1000).toFixed(1)} 秒 · 原始 ${r.events.filter(e=>e.t<=r.position).length} 次${r.trial ? ' / 试调 '+r.trial.events.filter(e=>e.t<=r.position).length+' 次' : ''} · ${iso(row[1])}`;
  }
  async function applyReplayTrial() {
    const r=S.replay;
    if(!isConsolePage || !S.consoleAuthenticated || !consoleSessionValid() || !r)return;
    const revision=(r.trialRevision||0)+1;r.trialRevision=revision;
    const input=document.getElementById('trialDrop'), gap=document.getElementById('trialRefractory');
    const drop=Number(input.value), refractory=Number(gap.value);
    const status=document.getElementById('trialStatus');
    r.trial=null;
    if(input.value.trim()==='' || gap.value.trim()==='' || !Number.isFinite(drop) || drop<0 || drop>4095 || !Number.isFinite(refractory) || refractory<0 || refractory>10000){status.textContent='请输入有效阈值（0–4095）和间隔（0–10000 ms）。';return;}
    status.textContent='正在按试调参数重算整条记录…';
    const config={...r.original.config,manualThresholdEnabled:true,manualDropCounts:drop,minDropCounts:0,refractoryMs:refractory};
    const detector=makeOfflineDetector(config,drop,r.original.blink_calibration);
    const events=[];
    for(let i=0;i<r.rows.length;i++){
      if(i%2000===0){await new Promise(resolve=>setTimeout(resolve,0));if(S.replay!==r || r.trialRevision!==revision)return;}
      const ev=detector(r.rows[i]);if(ev)events.push(ev);
    }
    r.trial={config,drop_counts:drop,events,computed_utc_ms:Date.now(),algorithm:'replay-fixed-threshold/v1',calibration_policy:'reuse-original-calibration-boundary-and-baseline'};
    status.textContent=`原始阈值 ${r.originalDrop ?? '未记录'} / ${r.events.length} 次 → 试调阈值 ${drop} / ${events.length} 次。仅改变回放标记；不覆盖原始参数和事件。`;
    seekReplay(r.position);
  }
  async function exportReplayComparison() {
    const r=S.replay;if(!r || !r.trial || !isConsolePage || !S.consoleAuthenticated || !consoleSessionValid())throw new Error('请先完成一次有效的重放试调。');
    const trial=JSON.parse(JSON.stringify(r.trial));
    const original=await buildBundle(JSON.parse(JSON.stringify(r.original)));
    saveBlob(`blink-comparison-${r.original.id}.json`,'application/json;charset=utf-8',[JSON.stringify({schema:'blink-analysis/v1',original,reanalysis:trial})]);
  }
  async function startReplay() {
    if (!isConsolePage || !S.consoleAuthenticated || !consoleSessionValid()) throw new Error('请在控制台登录后重放数据。');
    if (S.busy || S.startPending || !S.session || ['CAL','BLINKCAL','RUN','PAUSE'].includes(S.phase)) return;
    if (S.replay) {
      const r=S.replay;
      if(r.position>=r.end)seekReplay(r.start);
      r.playing=!r.playing; r.wall=performance.now();
    } else {
      S.busy=true; refreshButtons();
      try {
        await waitForWrites(); const id=S.session.id, rows=[];
        await visitChunks(id,c=>{for(const row of c.rows)rows.push(row);});
        if(!rows.length)throw new Error('这条记录没有可重放的采样点。');
        const events=(await readEvents(id)).filter(e=>e.type==='blink').map(e=>({t:e.timeline_ms,amp:e.amplitude_counts,width:e.width_ms}));
        S.viewingHistory=true;
        const original=JSON.parse(JSON.stringify(S.session));
        const originalDrop=original.blink_calibration?.threshold ?? original.detector?.drop_counts ?? null;
        S.replay={rows,events,original,originalDrop,start:rows[0][0],end:rows[rows.length-1][0],position:rows[0][0],playing:true,wall:performance.now(),visible:[]};
        document.body.classList.add('replay-focused');
        document.getElementById('trialDrop').value=originalDrop ?? '';
        document.getElementById('trialRefractory').value=original.config.refractoryMs;
        document.getElementById('originalReplayConfig').textContent=JSON.stringify({config:original.config,detector:original.detector,blink_calibration:original.blink_calibration},null,2);
        document.getElementById('trialStatus').textContent=`原始阈值 ${originalDrop ?? '未记录'}；原始 ${events.length} 次。修改下方试调参数会重算当前记录，原始数据保持不变。`;
        document.getElementById('replaySeek').max=String(S.replay.end-S.replay.start);
        seekReplay(S.replay.start);
        if(S.session.config.blinkCalEnabled && !Number.isFinite(S.session.blink_calibration?.run_baseline)) ui.help.textContent='旧记录缺少完整标定状态：重放展示原始事件，不保证重新分析与原始计数一致。';
      } finally {S.busy=false;refreshButtons();}
    }
    document.getElementById('btnReplay').textContent=S.replay.playing?'暂停重放':'继续重放';
  }
  function tickReplay() {
    const r=S.replay;if(!r || !r.playing)return;
    if(!isConsolePage || !S.consoleAuthenticated || !consoleSessionValid()){stopReplay();return;}
    const now=performance.now();
    if(now-r.wall<50)return; // Limit replay/UI updates to 20 Hz on phones.
    seekReplay(r.position+(now-r.wall)*Number(document.getElementById('replaySpeed').value));
    if(r.position>=r.end){r.playing=false;document.getElementById('btnReplay').textContent='重新播放';}
  }
  if (isConsolePage) {
  const dataPanel=document.createElement('section');
  dataPanel.className='card data-workbench';
  dataPanel.id='dataWorkbench';
  dataPanel.innerHTML=`
    <div class="data-heading"><h2>数据回放</h2><span class="data-badge">仅本机处理</span></div>
    <p class="tiny">导入已导出的数据，或打开本机记录，在上方波形中回放。不会修改原始数据。</p>
    <div class="data-grid">
      <div class="data-block"><h3>① 导入数据</h3>
        <label for="importFile">选择数据文件</label>
        <input id="importFile" type="file" accept=".json,application/json">
        <p class="tiny">支持单条 / 全部数据 · 最大 50 MB · 重复导入保留独立副本</p>
        <button id="btnImport" type="button" class="ghost">导入到本机</button>
        <p id="importStatus" class="tiny" role="status"></p>
      </div>
      <div class="data-block"><h3>② 打开记录</h3>
        <div id="replayRecords"></div>
      </div>
    </div>
    <div class="replay-bar">
      <div class="replay-title"><h3>③ 波形重放</h3><span id="replayRecordName" class="tiny">请先打开一条记录</span></div>
      <div class="replay-actions">
        <button id="btnReplay" type="button" class="primary">开始重放</button>
        <button id="btnReplayStop" type="button" class="ghost">退出重放</button>
        <label class="replay-speed" for="replaySpeed">速度 <select id="replaySpeed"><option value="0.5">0.5 倍</option><option value="1" selected>1 倍</option><option value="2">2 倍</option><option value="4">4 倍</option></select></label>
      </div>
      <label class="tiny" for="replaySeek">拖动定位</label>
      <input id="replaySeek" type="range" min="0" max="0" step="1" value="0">
      <p id="replayStatus" class="tiny">打开记录后开始重放；原始事件不等同于人工真值。</p>
      <details class="trial-panel"><summary>试调阈值 · 原始参数保留</summary>
        <div class="trial-fields"><label>下降阈值（ADC）<input id="trialDrop" type="number" min="0" max="4095" step="0.1"></label><label>最短间隔（ms）<input id="trialRefractory" type="number" min="0" max="10000" step="10"></label></div>
        <p id="trialStatus" class="tiny" role="status">先开始重放，再修改参数；修改仅用于当前记录试算，不用于正在采集的数据。</p>
        <details><summary>查看原始阈值及完整参数</summary><pre id="originalReplayConfig" class="tiny"></pre></details>
        <div class="trial-actions"><button id="trialReset" type="button" class="ghost">恢复原始标记</button><button id="trialExport" type="button" class="ghost">导出原始＋试调数据</button></div>
      </details>
    </div>`;
  document.getElementById('scope').closest('section').insertAdjacentElement('afterend',dataPanel);
  const replayViewport=document.createElement('div');replayViewport.className='replay-viewport';
  const wave=document.getElementById('scope').closest('section');
  wave.before(replayViewport);replayViewport.append(wave,dataPanel.querySelector('.replay-bar'));
  const records=document.getElementById('replayRecords');
  const oldRecordField=ui.sessionList.parentElement, oldLoadField=ui.btnLoad.parentElement;
  const recordLabel=document.createElement('label');recordLabel.htmlFor='sessionList';recordLabel.textContent='本机保存的测试';
  const actions=document.createElement('div');actions.className='record-actions';
  records.append(recordLabel,ui.sessionList,actions);
  actions.append(ui.btnLoad,ui.btnExportOne,ui.btnExportAll,ui.btnDeleteSession);
  oldRecordField.remove();oldLoadField.remove();
  document.getElementById('btnImport').onclick=async()=>{
    const file=document.getElementById('importFile').files[0];
    const status=document.getElementById('importStatus');
    try{
      if(!file)throw new Error('请先选择数据文件。');
      if(file.size>50*1024*1024)throw new Error('文件超过 50 MB，请拆分后导入。');
      status.textContent='正在校验并导入…';
      const ids=await importData(JSON.parse(await file.text()));
      status.textContent=`已导入 ${ids.length} 条，记录列表已选中首条。点击「打开所选测试」后重放。`;
      document.getElementById('importFile').value='';
    }catch(err){status.textContent='导入失败：'+err.message;}
  };
  document.getElementById('btnReplay').onclick=()=>startReplay().catch(err=>alert('重放失败：'+err.message));
  document.getElementById('btnReplayStop').onclick=stopReplay;
  const seek=document.getElementById('replaySeek');
  seek.addEventListener('pointerdown',()=>{if(S.replay){S.replay.scrubbing=true;S.replay.resumeAfterScrub=S.replay.playing;S.replay.playing=false;}});
  const finishScrub=()=>{if(S.replay?.scrubbing){S.replay.scrubbing=false;S.replay.playing=S.replay.resumeAfterScrub;S.replay.wall=performance.now();}};
  window.addEventListener('pointerup',finishScrub);window.addEventListener('pointercancel',finishScrub);
  seek.oninput=e=>{if(S.replay)seekReplay(S.replay.start+Number(e.target.value));};
  for(const id of ['trialDrop','trialRefractory'])document.getElementById(id).oninput=()=>applyReplayTrial().catch(err=>{document.getElementById('trialStatus').textContent='重算失败：'+err.message;});
  document.getElementById('trialReset').onclick=()=>{const r=S.replay;if(!r)return;r.trialRevision=(r.trialRevision||0)+1;r.trial=null;document.getElementById('trialDrop').value=r.originalDrop??'';document.getElementById('trialRefractory').value=r.original.config.refractoryMs;document.getElementById('trialStatus').textContent='已恢复原始事件标记，原始参数未改变。';seekReplay(r.position);};
  document.getElementById('trialExport').onclick=()=>exportReplayComparison().catch(err=>alert(err.message));
  }
  ui.btnExportBundle.onclick = () => { exportBundle().catch(err => { console.error(err); alert(`导出失败：${err.message || err}`); }); };
  ui.btnLoad.onclick = () => { loadSelectedSession().catch(console.error); };

  // 下拉框本身没有别的事件，选中项一变就刷新按钮可用状态
  ui.sessionList.onchange = () => refreshButtons();
  ui.btnExportOne.onclick = () => { exportSelectedSession().catch(err => { console.error(err); alert('导出失败：' + (err.message || err)); }); };
  ui.btnExportAll.onclick = () => { exportAllSessions().catch(err => { console.error(err); alert('导出失败：' + (err.message || err)); }); };

  ui.btnDeleteSession.onclick = async () => {
    if(S.busy || ['CAL','BLINKCAL','RUN','PAUSE'].includes(S.phase))return;
    const id = ui.sessionList.value;
    if (!id) return;
    const picked = ui.sessionList.selectedOptions[0];
    const label = picked ? picked.textContent : id;
    if (!confirm('删除这条本机测试？\n\n' + label + '\n\n会连同它的波形数据和事件一起删掉，删了不能恢复。')) return;
    stopReplay();
    S.busy = true; refreshButtons();
    try {
      await S.writeChain;                        // 等在途写入落盘，否则可能删完又被写回
      await deleteSession(id);
      if (S.session && S.session.id === id) {
        // 正在看的就是被删的那条，把界面复位
        setBlinkCount(0); S.events = []; S.samples = []; S.session = null; S.currentChunk = null;
        S.viewingHistory = false; S.writeError = null; S.recordingStartedAt = 0; S.phase = 'IDLE';
        S.rec = { t: [], raw: [], filt: [], ev: [] }; S.recStartMs = 0; S.recEndMs = 0;
        ui.mBpm.textContent = '--'; ui.mLast.textContent = '--'; S.shownBpm = null; pushStats();
        clearSummary(); setState('待机', 'badc');
      }
      await refreshSessionList();
      ui.sessionList.value = '';
      ui.help.textContent = '已删除所选的本机测试。';
    } catch (err) {
      console.error(err);
      alert('删除失败：' + (err.message || err));
    } finally { S.busy = false; refreshButtons(); }
  };

  // ------------------------------------------------------------------
  // 绘制
  // ------------------------------------------------------------------
  const scope = $('scope'), sctx = scope.getContext('2d');
  function resizeScope() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const r = scope.getBoundingClientRect();
    scope.width = Math.round(r.width * dpr);
    scope.height = Math.round(r.height * dpr);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => { resizeScope(); analyze(); });

  function draw() {
    requestAnimationFrame(draw);
    tickReplay();
    const r = scope.getBoundingClientRect(), W = r.width, H = r.height;
    sctx.clearRect(0, 0, W, H);
    sctx.fillStyle = '#050b13'; sctx.fillRect(0, 0, W, H);

    sctx.strokeStyle = '#18304a'; sctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const yy = H * i / 5;
      sctx.beginPath(); sctx.moveTo(0, yy); sctx.lineTo(W, yy); sctx.stroke();
    }

    const now = S.replay ? S.replay.position : S.lastT || 0;
    const pts = (S.replay ? S.replay.visible : S.samples).filter(p => p.t >= now - CFG.liveWindowMs && p.t <= now + 1);
    if (pts.length < 2) return;

    const t0 = now - CFG.liveWindowMs, t1 = now;
    const x = t => clamp((t - t0) / (t1 - t0), 0, 1) * W;

    // ---- 纵轴量程 ----
    // 固定 0..4095 映射时，只摆几十个计数的信号在 300px 高的画布上不到 4px，看着就是一条直线。
    // 自适应量程把可见窗口里的处理后波形拉到接近满高。三条约束：
    //   1) 只用处理后波形（filt）定量程 —— 原始波形毛刺大，让它参与就会把量程撑回去
    //   2) 放大快、缩小慢 —— 否则每帧跟着噪声抖，波形会不停"呼吸"
    //   3) 有半幅下限 —— 信号真的平直时，不能把噪声放大成假波形
    // 纵轴上下两端的数字始终是真实 ADC 计数，所以放大之后不会产生"看着像真信号"的误解。
    const autoOn = !!(ui.autoRange && ui.autoRange.checked);
    let center = CFG.adcMax / 2, half = CFG.adcMax / 2;
    if (autoOn) {
      let lo = Infinity, hi = -Infinity;
      for (const p of pts) { const v = p.filt; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        const tCenter = (lo + hi) / 2;
        let tHalf = clamp((hi - lo) / 2 * 1.15, CFG.autoRangeMinHalf, CFG.adcMax / 2);
        // 原始波形（灰线）毛刺比处理后波形大得多。完全不理会它，灰线会整条跑出画布；
        // 完全听它的，量程又会被毛刺撑回去、等于白放大。所以最多让它把量程撑宽 2.5 倍。
        let rLo = Infinity, rHi = -Infinity;
        for (const p of pts) { const v = p.raw; if (v < rLo) rLo = v; if (v > rHi) rHi = v; }
        if (Number.isFinite(rLo) && Number.isFinite(rHi)) {
          tHalf = clamp(Math.max(tHalf, Math.min((rHi - rLo) / 2, tHalf * 2.5)),
                        CFG.autoRangeMinHalf, CFG.adcMax / 2);
        }
        if (S.range.center === null) { S.range.center = tCenter; S.range.half = tHalf; }
        S.range.center += (tCenter - S.range.center) * 0.12;
        S.range.half += (tHalf - S.range.half) * (tHalf > S.range.half ? 0.30 : 0.02);
      }
      center = S.range.center; half = S.range.half;
    }
    // 超出画布的部分交给画布自己裁，这里只把坐标限制在宽松范围内，免得出现天文数字坐标。
    const y = v => clamp(H - ((v - (center - half)) / (2 * half)) * H, -4 * H, 5 * H);

    const trace = (key, color, width, alpha) => {
      sctx.globalAlpha = alpha; sctx.strokeStyle = color; sctx.lineWidth = width;
      sctx.beginPath();
      pts.forEach((p, i) => {
        const px = x(p.t), py = y(p[key]);
        if (!i || p.t - pts[i - 1].t > 12) sctx.moveTo(px, py); else sctx.lineTo(px, py);
      });
      sctx.stroke(); sctx.globalAlpha = 1;
    };
    trace('raw', '#70829a', 1, 0.45);
    trace('filt', '#38d996', 1.8, 1);

    if (S.baseline > 0) {
      [[S.thDown, '#ff6679'], [S.thUp, '#6ca9ff']].forEach(([v, c]) => {
        sctx.strokeStyle = c; sctx.setLineDash([6, 4]); sctx.lineWidth = 1;
        sctx.beginPath(); sctx.moveTo(0, y(v)); sctx.lineTo(W, y(v)); sctx.stroke();
        sctx.setLineDash([]);
      });
    }
    (S.replay ? (S.replay.trial?.events || S.replay.events) : S.events).filter(e => e.t >= t0 && e.t <= t1).forEach(e => {
      sctx.strokeStyle = '#f4bf4f'; sctx.lineWidth = 1;
      sctx.beginPath(); sctx.moveTo(x(e.t), 0); sctx.lineTo(x(e.t), H); sctx.stroke();
    });

    sctx.fillStyle = '#8ea3bd'; sctx.font = '11px ui-monospace';
    sctx.fillText(`${(CFG.liveWindowMs / 1000).toFixed(0)} s`, 8, H - 8);
    sctx.fillText(`${(center + half).toFixed(0)}`, 8, 13);
    sctx.fillText(`${(center - half).toFixed(0)}`, 8, H - 22);
    if (autoOn) sctx.fillText(`跨度 ${(2 * half).toFixed(0)}`, 8, 26);
  }

  // 实时统计刷新：卡片显示最近 30 秒次数，设备镜像仍接收同一时间窗
  // 换算出的次/分。两者都在同一个 tick 更新，暂停不会成为刷新触发条件。
  setInterval(() => {
    const active = S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'RUN';
    if (active && !S.busy && !S.timeoutHandling && S.recordingStartedAt) {
      const lastActivity = S.lastSampleAt || S.recordingStartedAt;
      if (performance.now() - lastActivity > CFG.sampleTimeoutMs) {
        S.timeoutHandling = true;
        S.quality.dataTimeouts = (S.quality.dataTimeouts || 0) + 1;
        S.quality.discontinuities = (S.quality.discontinuities || 0) + 1;
        stopSession('data_timeout').catch(err => {
          console.error(err);
          ui.help.textContent = '采集数据已停止，但保存状态异常，请重新测试。';
        }).finally(() => { S.timeoutHandling = false; });
      }
    }
    if (active && !S.busy && S.session && Number.isFinite(S.session.first_timeline_ms) &&
        S.lastT - S.session.first_timeline_ms >= CFG.maxRecordMs) {
      stopSession('max_duration').catch(console.error);
    }
    if (S.phase === 'CAL' || S.phase === 'BLINKCAL' || S.phase === 'RUN' || S.phase === 'PAUSE') {
      updateLiveStats();
    }
    pushStats();
  }, 500);

  applyConsoleConfig(S.consoleConfig);
  resizeScope(); draw(); refreshButtons(); clearSummary(); refreshSessionList();
  window.__blink = { S, CFG, onSample, analyze, beginFormalSession, exportBundle };
})();
