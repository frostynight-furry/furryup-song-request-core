'use strict';
// Synthetic provider and player: no network request, real music, or account.
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SongRequests, defaults } = require('../core/index.cjs');
class DemoPlayer extends EventEmitter {
  constructor() { super(); this.pending = new Map(); this.devices = []; }
  play({ id }) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({}); }, 30);
      this.pending.set(id, { timer, resolve });
      queueMicrotask(() => this.emit('playback-started', id));
    });
  }
  stop(id) { const task = this.pending.get(id); if (task) { clearTimeout(task.timer); task.resolve({ cancelled: true }); this.pending.delete(id); } }
  setVolume() {}
  setPaused() {}
}
async function replay() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'furryup-song-example-'));
  const providers = {
    snapshot: () => ({ netease: { configured: true } }),
    search: async () => [{ id: 'fixture-track', title: '示例旋律（Live）', artist: '示例乐队', duration: 1 }],
    resolve: async () => ({ url: 'https://media.example.invalid/synthetic.wav', duration: 1 })
  };
  const engine = new SongRequests({ directory, backend: new DemoPlayer(), providers });
  try {
    engine.configure({ ...defaults(), enabled: true, musicProvider: 'auto', cooldownSeconds: 0 });
    const finished = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Synthetic replay timed out')), 3000);
      engine.on('change', () => { if (engine.history.some(row => row.state === '已播放')) { clearTimeout(deadline); resolve(); } });
    });
    const accepted = await engine.accept({ platform: 'bilibili', room_id: 'demo-room', user_id: 'demo-viewer', user_name: '示例观众', event_id: 'demo-1', event_type: 'comment', content: '点歌+示例旋律+示例乐队' });
    if (!accepted.accepted) throw new Error(accepted.reason);
    await finished;
    console.log(JSON.stringify({ simulated: true, audioPlayed: false, accepted: accepted.accepted, history: engine.snapshot().history }, null, 2));
  } finally { await engine.dispose(); if (path.dirname(directory) === os.tmpdir()) fs.rmSync(directory, { recursive: true, force: true }); }
}
if (require.main === module) replay().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { replay, DemoPlayer };
