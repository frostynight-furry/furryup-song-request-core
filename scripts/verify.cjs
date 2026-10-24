'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { root, assertSource } = require('./audit-source.cjs');
try {
  const audited = assertSource();
  const tests = fs.readdirSync(root + '/test').filter(name => name.endsWith('.test.cjs')).map(name => 'test/' + name);
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) process.exitCode = 1;
  else console.log(`Verified ${audited.files.length} allowlisted source files. Private-reference release audit is a separate maintainer gate.`);
} catch { console.error('Verification failed'); process.exitCode = 1; }
