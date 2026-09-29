const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const FakeTimers = require('@sinonjs/fake-timers');
const acorn = require('acorn');
const { readPageSource, scriptSource } = require('./source');

function loadPage(page = 'index.html', options = {}) {
  const file = path.resolve(options.root || path.join(__dirname, '../..'), page);
  const html = readPageSource(file);
  const warnings = [], errors = [], downloads = [], alerts = [];
  const vc = new VirtualConsole();
  vc.on('warn', (...args) => warnings.push(args.join(' ')));
  vc.on('error', (...args) => errors.push(args.join(' ')));
  vc.on('jsdomError', err => errors.push(err.message));
  const dom = new JSDOM(html, { url: 'https://blink.test/' + page, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const clock = FakeTimers.withGlobal(w).install({ now: 1700000000000, toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange;
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.Blob = Blob;
  w.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.alert = msg => alerts.push(msg); w.confirm = () => true;
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (t,k) => k in t ? t[k] : k === 'measureText' ? () => ({width:16}) : k === 'getImageData'
      ? (x,y,width,height) => ({data:new Uint8ClampedArray(width*height*4),width,height})
      : k === 'createLinearGradient' ? () => ({addColorStop(){}}) : () => {},
    set: (t,k,v) => {t[k]=v;return true;}
  });
  w.HTMLElement.prototype.getBoundingClientRect = () => ({width:800,height:300,top:0,left:0});
  if (options.session) w.sessionStorage.setItem('blink-console-auth-v1', JSON.stringify({expiresAt:w.Date.now()+1800000}));
  options.setup?.(w);
  const code = scriptSource(html);
  const ast = acorn.parse(code, {ecmaVersion:'latest'});
  const iife = ast.body.find(n => n.expression?.callee?.type === 'ArrowFunctionExpression').expression.callee;
  const names = iife.body.body.filter(n => n.type === 'FunctionDeclaration').map(n => n.id.name);
  const end = iife.body.end-1;
  w.eval(code.slice(0,end) + '\nwindow.__test = {S,CFG,ui,'+names.join(',')+'};\n' + code.slice(end));
  return { w, app:w.__test, clock, warnings, errors, downloads, alerts, close() { clock.uninstall(); dom.window.close(); } };
}
module.exports = { loadPage };
