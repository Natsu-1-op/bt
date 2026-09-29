const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

function readPageSource(file) {
  const html = fs.readFileSync(file, 'utf8');
  return html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g, (_, url) => {
    if (/^(https?:|\/\/)/.test(url)) throw new Error('Unexpected remote application script: ' + url);
    const filePath = path.resolve(path.dirname(file), url.split('?')[0]);
    return '<script>\n' + fs.readFileSync(filePath, 'utf8') + '\n</script>';
  });
}
function scriptSource(src) {
  if (!src.includes('<script')) return src;
  const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!scripts.length || !scripts.some(s => s.trim())) throw new Error('Missing application script');
  return scripts.join('\n');
}
function extractFunction(src, name) {
  const code = scriptSource(src);
  const ast = acorn.parse(code, { ecmaVersion: 'latest' });
  const matches = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id.name === name) matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  if (matches.length !== 1) throw new Error(`Expected one function ${name}, found ${matches.length}`);
  return code.slice(matches[0].start, matches[0].end);
}
module.exports = { readPageSource, scriptSource, extractFunction };
