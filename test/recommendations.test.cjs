'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { SongRequests, defaults, selectMatchingTracks } = require('../core/index.cjs');

async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); }
  assert.fail('Expected playback transition did not happen');
}
class Backend extends EventEmitter {
  constructor() { super(); this.plays = []; this.waiting = new Map(); this.stops = []; }
  play(input) {
    this.plays.push(input);
    const promise = new Promise(resolve => this.waiting.set(input.id, resolve));
    this.emit('playback-started', input.id); return promise;
  }
  finish(id, result = {}) { const done = this.waiting.get(id); this.waiting.delete(id); done?.(result); }
  stop(id) { this.stops.push(id); this.finish(id, { cancelled: true }); }
  setPaused() {}
  setVolume() {}
}
function makeProvider() {
  const providers = new EventEmitter();
  providers.sourceRevision = 0; providers.calls = [];
  providers.snapshot = () => ({ qq: { configured: true }, netease: { configured: true } });
  providers.recommend = async provider => {
    providers.calls.push(provider);
    return Array.from({ length: 4 }, (_, i) => ({ provider, id: `${provider}${i}`, title: `${provider}推荐${i}`, artist: '推荐歌手', duration: 180 }));
  };
  providers.search = async (provider, title) => [{ provider, id: title, title, artist: '点歌歌手', duration: 200 }];
  providers.resolve = async track => ({ url: `https://music.example/${track.id}.mp3`, duration: track.duration });
  providers.retainTracks = () => {}; providers.releaseTracks = () => {};
  return providers;
}
function setup(t, providers = makeProvider()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fus-recommend-'));
  const backend = new Backend();
  const engine = new SongRequests({ directory, backend, providers });
  engine.configure({ ...defaults(), enabled: true, autoPlay: true, musicProvider: 'qq', cooldownSeconds: 0 });
  engine.startRecommendations();
  t.after(async () => { await engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { engine, backend, directory, providers };
}

test('recommendations finish naturally, requests keep arrival order, then alternating recommendations resume', async t => {
  const { engine, backend } = setup(t);
  engine.configureRecommendations(true);
  await until(() => backend.plays.length === 1);
  const recommendation = engine.current;
  assert.equal(recommendation.track.provider, 'qq');
  const viewer = { platform: 'bilibili', room_id: 'room', user_id: 'viewer', user_name: '观众' };
  assert.equal((await engine.request('观众歌曲一', viewer)).accepted, true);
  assert.equal((await engine.request('观众歌曲二', { ...viewer, user_id: 'viewer2' })).accepted, true);
  assert.equal(engine.current, recommendation);
  assert.equal(backend.plays.length, 1); assert.equal(backend.stops.length, 0);
  assert.equal(engine.snapshot().recommendations.waitingForRequests, true);
  backend.finish(recommendation.audioId);
  await until(() => backend.plays.length === 2);
  assert.equal(engine.current.track.title, '观众歌曲一');
  backend.finish(engine.current.audioId);
  await until(() => backend.plays.length === 3);
  assert.equal(engine.current.track.title, '观众歌曲二');
  backend.finish(engine.current.audioId);
  await until(() => backend.plays.length === 4);
  assert.equal(engine.current.track.provider, 'netease');
  assert.equal(engine.snapshot().current.origin, 'recommendation');
  backend.finish(engine.current.audioId);
  await until(() => backend.plays.length === 5);
  assert.equal(engine.current.track.provider, 'qq');
  assert.equal(engine.current.track.title, 'qq推荐1');
  assert.deepEqual(engine.snapshot().queue, []);
});

test('an audience request arriving during a slow recommendation fetch takes priority', async t => {
  const providers = makeProvider(); let release;
  const original = providers.recommend;
  providers.recommend = provider => new Promise(resolve => { release = async () => resolve(await original(provider)); });
  const { engine, backend } = setup(t, providers);
  engine.configureRecommendations(true);
  await until(() => release);
  const requested = await engine.request('抢先点歌', { manual: true });
  assert.equal(requested.accepted, true);
  await until(() => backend.plays.length === 1);
  await release(); await delay(15);
  assert.equal(engine.current.track.title, '抢先点歌');
  assert.equal(backend.plays.length, 1);
  backend.finish(engine.current.audioId);
  await until(() => backend.plays.length === 2);
  assert.equal(engine.current.track.title, 'qq推荐0');
});

test('space-separated song requests prefer the entire artist over a duet, without narrowing manual search', async t => {
  const providers = makeProvider();
  const original = { provider: 'qq', id: 'original', title: '晴天', artist: '周杰伦', duration: 269 };
  const duet = { ...original, id: 'duet', artist: '林俊杰 / 周杰伦', duration: 239 };
  assert.deepEqual(selectMatchingTracks('晴天 周杰伦', [duet, original]), [original]);
  assert.deepEqual(selectMatchingTracks('晴天+周杰伦', [duet, original]), [original]);
  providers.search = async () => [duet, original];
  const { engine } = setup(t, providers);
  assert.equal((await engine.search('晴天 周杰伦', 'qq')).length, 2);
  assert.equal((await engine.request('晴天 周杰伦', { manual: true })).accepted, true);
  assert.equal(engine.current.track.id, original.id);
  engine.skip();
  assert.equal((await engine.request('晴天', { manual: true })).accepted, false, 'unspecified artists stay ambiguous');
  providers.search = async () => [duet];
  assert.equal((await engine.request('晴天 周杰伦', { manual: true })).accepted, true, 'a sole duet is still supported');
});

test('a current recommendation does not use the only available audience request slot', async t => {
  const { engine, backend } = setup(t);
  engine.configure({ ...engine.settings, maxQueue: 1 });
  engine.configureRecommendations(true); await until(() => backend.plays.length === 1);
  const current = engine.current;
  assert.equal((await engine.request('观众一', { manual: true })).accepted, true);
  assert.equal((await engine.request('观众二', { manual: true })).accepted, false);
  assert.equal(engine.current, current);
  backend.finish(current.audioId); await until(() => backend.plays.length === 2);
  assert.equal(engine.current.track.title, '观众一');
});

test('completion-only players still alternate recommendations', async t => {
  const { engine, backend } = setup(t);
  backend.removeAllListeners('playback-started');
  engine.configureRecommendations(true); await until(() => backend.plays.length === 1);
  assert.equal(engine.current.track.provider, 'qq');
  backend.finish(engine.current.audioId); await until(() => backend.plays.length === 2);
  assert.equal(engine.current.track.provider, 'netease');
});

test('pause, emergency and disable cannot let an in-flight recommendation start playback', async t => {
  for (const action of ['pause', 'emergency', 'disable']) {
    await t.test(action, async t => {
      const providers = makeProvider(); let release;
      providers.recommend = provider => new Promise(resolve => { release = () => resolve([{ provider, id: 'late', title: '迟到推荐', artist: '歌手' }]); });
      const { engine, backend } = setup(t, providers);
      engine.configureRecommendations(true); await until(() => release);
      if (action === 'disable') engine.configureRecommendations(false);
      else engine[action](true);
      release(); await delay(30);
      assert.equal(backend.plays.length, 0);
      assert.equal(engine.current, null);
    });
  }
});

test('a failed source falls back to the other account and empty feeds use bounded retry', async t => {
  const providers = makeProvider(), original = providers.recommend;
  providers.recommend = async provider => { if (provider === 'qq') throw Error('private upstream error'); return original(provider); };
  const { engine, backend } = setup(t, providers);
  engine.configureRecommendations(true);
  await until(() => backend.plays.length === 1);
  assert.equal(engine.current.track.provider, 'netease');
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /private upstream/);
  engine.skip(); await until(() => backend.plays.length === 2);
  assert.equal(engine.current.track.provider, 'netease');
  engine.configureRecommendations(false); engine.skip();
  providers.recommend = async () => [];
  engine.recommendationCaches.clear(); engine.recommendationCooldowns.clear();
  engine.configureRecommendations(true); await until(() => engine.recommendationTimer && !engine.recommendationFetch);
  await delay(30); assert.equal(backend.plays.length, 2);
  assert.match(engine.snapshot().recommendations.message, /稍后会自动重试/);
});

test('recommendation settings and rotation survive restart without changing existing song settings', async t => {
  const { engine, backend, directory, providers } = setup(t);
  const settings = fs.readFileSync(path.join(directory, 'song-requests.json'), 'utf8');
  engine.configureRecommendations(true); await until(() => backend.plays.length === 1);
  assert.equal(fs.readFileSync(path.join(directory, 'song-requests.json'), 'utf8'), settings);
  await engine.dispose();
  const second = new SongRequests({ directory, backend: new Backend(), providers });
  t.after(() => second.dispose());
  assert.equal(second.snapshot().recommendations.enabled, true);
  assert.equal(second.snapshot().recommendations.nextProvider, 'netease');
  assert.equal(second.settings.musicProvider, 'qq');
  second.startRecommendations(); await until(() => second.current?.playbackStarted);
  assert.equal(second.current.track.provider, 'netease');
  await second.dispose();
});

test('recommendation trial failures do not block a queued viewer request', async t => {
  const providers = makeProvider(); let release;
  providers.resolve = track => track.title.includes('推荐') ? new Promise((_resolve, reject) => { release = () => reject(Object.assign(Error('preview'), { code: 'MUSIC_TRIAL_ONLY' })); }) : Promise.resolve({ url: 'https://music.example/request.mp3' });
  const { engine, backend } = setup(t, providers);
  engine.configureRecommendations(true); await until(() => release);
  await engine.request('排队歌曲', { manual: true }); release();
  await until(() => backend.plays.length === 1);
  assert.equal(engine.current.track.title, '排队歌曲');
  assert.equal(engine.history.some(row => row.state === '播放失败'), true);
});
