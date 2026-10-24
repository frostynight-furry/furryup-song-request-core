'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, digest, inspectBytes, assertSource, readManifest } = require('./audit-source.cjs');
function tar(args) { return execFileSync('tar', args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
function readArchive(filename, directory = root) {
  const names = tar(['-tf', filename]).toString().trim().split(/\r?\n/).filter(Boolean);
  const listing = tar(['-tvf', filename]).toString().trim().split(/\r?\n/).filter(Boolean);
  const allowed = readManifest(directory);
  if (new Set(names).size !== names.length || names.length !== allowed.length ||
      names.some(name => !allowed.includes(name)) || listing.length !== names.length || listing.some(row => !row.startsWith('-'))) throw new Error('Unexpected archive entry');
  return names.map(name => ({ name, bytes: tar(['-xOf', filename, name]) }));
}
function auditArchive(filename, directory = root) {
  const source = assertSource(directory), entries = readArchive(filename, directory);
  for (const { name, bytes } of entries) {
    if (inspectBytes(name, bytes).length || source.files.find(row => row.path === name)?.sha256 !== digest(bytes)) throw new Error('Archive content differs from audited source');
  }
  return { state: 'passed', files: entries.length, size: fs.statSync(filename).size, sha256: digest(fs.readFileSync(filename)) };
}
function pack(filename, directory = root) {
  const output = path.resolve(filename), relative = path.relative(directory, output);
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Archive must be outside the source directory');
  const source = assertSource(directory);
  if (fs.existsSync(output)) throw new Error('Archive already exists');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  tar(['-cf', output, '-C', directory, ...source.files.map(row => row.path)]);
  return auditArchive(output, directory);
}
if (require.main === module) { try { if (!process.argv[2]) throw new Error('Output required'); console.log(JSON.stringify(pack(process.argv[2]), null, 2)); } catch { console.error('Archive audit failed; no distribution approved'); process.exitCode = 1; } }
module.exports = { pack, auditArchive, readArchive };
