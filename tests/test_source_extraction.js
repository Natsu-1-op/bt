const assert = require('node:assert/strict');
const { readPageSource, extractFunction } = require('./helpers/source');
for(const page of ['index.html','test.html']) {
  const source = readPageSource(page);
  const reset = extractFunction(source,'resetFilter');
  assert.equal(reset, 'function resetFilter() { S.ma = []; S.maSum = 0; }');
  const hide = extractFunction(source,'hideCloudGate');
  assert(!hide.includes('startWithCloudSync'));
  assert.throws(()=>extractFunction(source,'notAFunction'));
}
const tricky = 'function a(){return `} ${(() => ({x:"}"}))().x}`;} function b(){}';
assert(!extractFunction(tricky,'a').includes('function b'));
assert.throws(()=>extractFunction('function a(){} function a(){}','a'));
console.log('PASS AST extraction: inline functions, templates, duplicates, missing functions');
