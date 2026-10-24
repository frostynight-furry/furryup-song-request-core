'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function readManifest(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'source-files.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || new Set(manifest.files).size !== manifest.files.length) throw new Error('Invalid source manifest');
  for (const name of manifest.files) if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || name.startsWith('.git/')) throw new Error('Unsafe manifest path');
  return manifest.files;
}
function inspectBytes(name, bytes) {
  const findings = [];
  if (bytes.length > 2 * 1024 * 1024) return ['oversized-source'];
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return ['non-text-payload']; }
  if (bytes.includes(0)) findings.push('binary-payload');
  const decoded = text.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a, b, c) => {
    const n = parseInt(a || b || c, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
  if (/(?:[A-Za-z]:[\\/]Users[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/.test(decoded)) findings.push('credential-or-user-path');
  if (/(?:https?:\/\/[^\s'"`]+\/rule-packs\/|source-coach-curriculum\.json|assistant-(?:guidance|playbooks|text-(?:coaching|online|experience|interactions|runtime))\.json)/i.test(decoded)) findings.push('private-content-reference');
  if (/[A-Za-z0-9+/]{400,}={0,2}/.test(decoded)) findings.push('opaque-encoded-payload');
  if (name.startsWith('core/')) {
    for (const match of decoded.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!match[1].startsWith('node:') && !/^\.\/[a-z-]+\.cjs$/.test(match[1])) findings.push('nonportable-runtime-import');
    }
    if (/\b(?:eval|Function)\s*\(|\bimport\s*\(/.test(decoded)) findings.push('dynamic-execution');
  }
  return findings;
}
function auditSource(directory = root, { tracked = false } = {}) {
  const allowed = new Set(readManifest(directory)), files = [], findings = [];
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Linked root is not allowed');
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (name === '.git') continue;
      if (entry.isSymbolicLink()) { findings.push({ file: name, reason: 'link' }); continue; }
      if (entry.isDirectory()) { walk(name); continue; }
      if (!entry.isFile() || !allowed.has(name)) { findings.push({ file: name, reason: 'outside-allowlist' }); continue; }
      const bytes = fs.readFileSync(path.join(directory, name));
      files.push({ path: name, size: bytes.length, sha256: digest(bytes) });
      for (const reason of inspectBytes(name, bytes)) findings.push({ file: name, reason });
    }
  }
  walk(); for (const name of allowed) if (!files.some(row => row.path === name)) findings.push({ file: name, reason: 'missing' });
  if (tracked) {
    const git = args => execFileSync('git', args, { cwd: directory, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const entries = git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
    const indexed = new Set();
    for (const row of entries) {
      const match = /^(100644|100755) ([a-f0-9]+) 0\t(.+)$/.exec(row);
      if (!match) { findings.push({ file: '.git/index', reason: 'nonregular-index-entry' }); continue; }
      const [, , oid, name] = match; indexed.add(name);
      if (!allowed.has(name)) { findings.push({ file: name, reason: 'unapproved-index-entry' }); continue; }
      const bytes = git(['cat-file', 'blob', oid]);
      for (const reason of inspectBytes(name, bytes)) findings.push({ file: name, reason });
      if (files.find(row => row.path === name)?.sha256 !== digest(bytes)) findings.push({ file: name, reason: 'index-mismatch' });
    }
    for (const name of allowed) if (!indexed.has(name)) findings.push({ file: name, reason: 'not-indexed' });
  }
  return { state: findings.length ? 'failed' : 'passed', files: files.sort((a, b) => a.path.localeCompare(b.path)), findings };
}
function assertSource(directory = root, options) { const result = auditSource(directory, options); if (result.state !== 'passed') throw Object.assign(new Error('Source audit failed'), { report: result }); return result; }
if (require.main === module) { try { console.log(JSON.stringify(assertSource(root, { tracked: process.argv.includes('--tracked') }), null, 2)); } catch (error) { console.error(JSON.stringify(error.report || { state: 'failed', reason: 'audit-unavailable' })); process.exitCode = 1; } }
module.exports = { root, digest, readManifest, inspectBytes, auditSource, assertSource };
