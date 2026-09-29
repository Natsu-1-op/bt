#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseHex(text, name) {
  const records = [];
  let upper = 0;
  for (const [index, raw] of text.replace(/\r/g, '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith(':') || ((line.length - 1) & 1)) throw new Error(`${name}:${index + 1}: invalid record`);
    const b = Buffer.from(line.slice(1), 'hex');
    if (b.length < 5 || b.length !== b[0] + 5) throw new Error(`${name}:${index + 1}: invalid length`);
    let sum = 0; for (const v of b) sum = (sum + v) & 0xff;
    if (sum !== 0) throw new Error(`${name}:${index + 1}: checksum mismatch`);
    const type = b[3];
    if (type === 0x00) records.push({ address: upper + b.readUInt16BE(1), data: b.subarray(4, 4 + b[0]) });
    else if (type === 0x04) upper = b.readUInt16BE(4) << 16;
    else if (type === 0x02) upper = b.readUInt16BE(4) << 4;
  }
  return records;
}

function encodeRecord(address, data, type = 0) {
  const b = Buffer.alloc(5 + data.length);
  b[0] = data.length; b.writeUInt16BE(address & 0xffff, 1); b[3] = type;
  data.copy(b, 4);
  let sum = 0; for (const v of b) sum = (sum + v) & 0xff;
  b[b.length - 1] = (-sum) & 0xff;
  return `:${[...b].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

if (process.argv.length !== 5) {
  console.error('usage: node tools/merge-intel-hex.js bootloader.hex application.hex output.hex');
  process.exit(2);
}

const all = [...parseHex(fs.readFileSync(process.argv[2], 'utf8'), process.argv[2]),
             ...parseHex(fs.readFileSync(process.argv[3], 'utf8'), process.argv[3])];
const bytes = new Map();
for (const record of all) {
  for (let i = 0; i < record.data.length; ++i) {
    const address = record.address + i;
    const old = bytes.get(address);
    if (old !== undefined && old !== record.data[i]) throw new Error(`overlap conflict at 0x${address.toString(16)}`);
    bytes.set(address, record.data[i]);
  }
}

const sorted = [...bytes.keys()].sort((a, b) => a - b);
const out = [];
let upper = null;
let i = 0;
while (i < sorted.length) {
  const address = sorted[i];
  const nextUpper = address >>> 16;
  if (upper !== nextUpper) {
    upper = nextUpper;
    const ext = Buffer.alloc(2); ext.writeUInt16BE(upper, 0);
    out.push(encodeRecord(0, ext, 4));
  }
  const data = Buffer.alloc(Math.min(16, sorted.length - i));
  let n = 0;
  while (n < data.length && sorted[i + n] === address + n && (sorted[i + n] >>> 16) === upper) {
    data[n] = bytes.get(sorted[i + n]); ++n;
  }
  out.push(encodeRecord(address & 0xffff, data.subarray(0, n)));
  i += n;
}
out.push(':00000001FF');
fs.writeFileSync(process.argv[4], `${out.join('\n')}\n`);
