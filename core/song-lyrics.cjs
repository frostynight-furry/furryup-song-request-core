'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LIMIT = 256_000;

// Timestamp parsing adapted from music-metadata 11.16.1 (MIT, see LRC-LICENSE.txt).
// Repeated tags, global offsets and empty instrumental intervals occur in local and provider LRC.
function parseLrc(input) {
  if (typeof input !== 'string' || input.length > LIMIT) return [];
  const offset = Number(input.match(/^\s*\[offset:\s*([+-]?\d{1,7})\s*]/im)?.[1] || 0);
  const cues = new Map();
  for (const row of input.split(/\r\n?|\n/)) {
    const prefix = row.trimStart().match(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]\s*)+/)?.[0];
    if (!prefix) continue;
    const text = row.trimStart().slice(prefix.length).replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, '').trim().slice(0, 500);
    for (const m of prefix.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
      const ms = Math.max(0, (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number((m[3] || '').padEnd(3, '0')) - offset);
      if (!cues.get(ms)) cues.set(ms, text);
      if (cues.size > 8192) return [];
    }
  }
  if (![...cues.values()].some(Boolean)) return [];
  return [...cues].sort((a, b) => a[0] - b[0]);
}

function stanza(cues, seconds) {
  let low = 0, high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle][0] <= seconds * 1000) low = middle + 1;
    else high = middle;
  }
  const index = low - 1, lines = ['', cues[index]?.[1] || '', '', ''];
  for (let i = index - 1; i >= 0; i--) if (cues[i][1]) { lines[0] = cues[i][1]; break; }
  for (let i = low, slot = 2; i < cues.length && slot < 4; i++) if (cues[i][1]) lines[slot++] = cues[i][1];
  return { lines, interval: index < 0 ? 'intro' : !lines[1] ? (lines[2] ? 'instrumental' : 'outro') : null };
}

function sidecar(file) { return path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.lrc'); }
function readSidecar(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMIT) return '';
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return '';
    if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('gb18030').decode(bytes); }
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { parseLrc, stanza, sidecar, readSidecar };
