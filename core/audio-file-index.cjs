'use strict';
const fs = require('node:fs');

// Snapshots are memory-only. External changes are reconciled asynchronously at
// most once per interval; application-owned imports update the index at commit.
class AudioFileIndex {
  constructor(directory, { io = fs, now = Date.now, intervalMs = 2000, onChange = () => {} } = {}) {
    this.directory = directory; this.io = io; this.now = now; this.intervalMs = intervalMs; this.onChange = onChange;
    this.revision = 0; this.disposed = false; this.pending = null;
    try { this.files = new Set(io.readdirSync(directory)); } catch { this.files = new Set(); }
    this.nextCheck = now() + intervalMs;
  }
  snapshot() {
    if (!this.disposed && this.now() >= this.nextCheck) void this.refresh();
    return this.files;
  }
  add(files) { this.revision++; for (const file of files) this.files.add(file); }
  remove(file) { this.revision++; this.files.delete(file); }
  refresh() {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const revision = this.revision;
    this.nextCheck = this.now() + this.intervalMs;
    this.pending = (async () => {
      try {
        const files = new Set(await this.io.promises.readdir(this.directory));
        if (this.disposed || this.revision !== revision) return;
        const changed = files.size !== this.files.size || [...files].some(file => !this.files.has(file));
        this.files = files;
        if (changed) this.onChange();
      } catch { /* A transient directory read failure must not mark every track missing. */ }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  dispose() { this.disposed = true; }
}
module.exports = { AudioFileIndex };
