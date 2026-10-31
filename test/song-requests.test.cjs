'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { SongRequests, defaults, validateSettings, matchFormat, parseSongQuery, selectMatchingTracks } = require('../core/index.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Backend extends EventEmitter {
  constructor() { super(); this.plays = []; this.waiting = new Map(); this.pauses = []; this.devices = [{ id: 'default', label: '默认' }]; }
  play(value) { this.plays.push(value); const result = deferred(); this.waiting.set(value.id, result); return result.promise; }
  stop(id) { this.waiting.get(id)?.resolve({ cancelled: true }); this.waiting.delete(id); }
  finish(id, result = {}) { this.waiting.get(id)?.resolve(result); this.waiting.delete(id); }
  setPaused(id, value) { this.pauses.push({ id, value }); }
  setVolume(id, volume) { (this.volumeChanges ||= []).push({ id, volume }); }
}
function song(id, title = id, provider = 'netease') { return { id, provider, title, artist: '歌手' }; }
function setup(t, { providers, now, settings = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'furry-song-'));
  const backend = new Backend();
  const engine = new SongRequests({ directory, backend, providers, now });
  engine.configure({ ...defaults(), enabled: true, autoPlay: false, cooldownSeconds: 0, ...settings });
  t.after(async () => {
    await engine.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { engine, backend, directory };
}
function platformSettings(overrides = {}) {
  const result = defaults().platforms;
  result.bilibili = { ...result.bilibili, ...overrides }; return result;
}
const viewer = { platform: 'bilibili', room_id: 'room', user_id: 'alice', user_name: '小明' };
function comment(content, event_id = crypto.randomUUID(), context = viewer) { return { ...context, event_type: 'comment', event_id, content }; }
function gift(gift_count = 1, event_id = crypto.randomUUID(), context = viewer, extra = {}) {
  return { ...context, event_type: 'gift', event_id, gift_id: 'gift-1', gift_name: '小花', gift_count, count_mode: 'delta', ...extra };
}
const creditRule = { giftId: 'gift-1', giftName: '小花', minCount: 1, mode: 'credit', song: '' };

test('recognized requests record early rejection reasons once, including emergency stop', async t => {
  const { engine } = setup(t, { settings: { platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  const event = comment('点歌 海底 凤凰传奇');
  const denied = await engine.accept(event);
  assert.equal(engine.history[0]?.detail, denied.reason);
  assert.equal(engine.history[0].label, '海底 凤凰传奇');
  assert.equal(engine.history[0].user_name, viewer.user_name);
  const count = engine.history.length;
  await engine.accept(event); await engine.accept(comment('普通聊天'));
  await engine.accept({ ...comment('点歌 测试'), preview: true });
  assert.equal(engine.history.length, count, 'duplicates, ordinary chat and preview do not create request records');
  engine.emergency();
  const stopped = await engine.accept(comment('点歌 海底 凤凰传奇'));
  assert.match(stopped.reason, /继续播放/);
  assert.equal(engine.history[0].detail, stopped.reason);
  assert.equal(engine.queue.length, 0);
  engine.configure({ ...engine.settings, enabled: false }); engine.pause(false);
  assert.equal((await engine.accept(comment('点歌 海底 凤凰传奇'))).reason, '点歌未启用');
  assert.equal(engine.history[0].detail, '点歌未启用');
});

test('matching Live recordings on different providers remain available for automatic fallback', () => {
  const netease = { id: '1840192925', provider: 'netease', title: '海底（Live）', artist: '凤凰传奇', duration: 256 };
  const qq = { ...netease, id: 'qq-haidi', provider: 'qq', title: '海底 (Live)', duration: 258 };
  for (const query of ['海底 凤凰传奇', '海底+凤凰传奇']) {
    assert.deepEqual(selectMatchingTracks(query, [netease, qq]), [netease, qq]);
    assert.throws(() => selectMatchingTracks(query, [netease, { ...qq, duration: 400 }]), { code: 'SONG_AMBIGUOUS' });
  }
});

test('playback acknowledgement and fallback IDs prevent stale completion from controlling another source', async t => {
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true } }),
    search: async (provider, query) => [song(provider, query, provider)],
    resolve: async () => ({ url: 'https://music.example/song.mp3' })
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true } });
  await engine.accept(comment('点歌 first')); await nextTurn();
  assert.equal(engine.current.stage, '正在加载音频');
  const first = backend.plays[0].id;
  backend.emit('playback-started', first);
  assert.equal(engine.current.stage, '正在播放');
  backend.finish(first, { error: 'private URL', code: 'AUDIO_INCOMPLETE_SOURCE' }); await nextTurn();
  const second = backend.plays[1].id;
  assert.notEqual(second, first);
  backend.emit('playback-started', first); backend.finish(first);
  assert.equal(engine.current.stage, '正在加载音频');
  backend.emit('playback-started', second);
  engine.pause(true); assert.deepEqual(backend.pauses.at(-1), { id: second, value: true });
  engine.pause(false); backend.finish(second, { error: 'secret token', code: 'AUDIO_DEVICE_FAILED' }); await nextTurn();
  assert.equal(engine.history[0].state, '播放失败');
  assert.match(engine.history[0].detail, /输出设备/);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /private URL|secret token/);
});

test('formats match literal punctuation and only extract one song placeholder', () => {
  const configuration = defaults();
  configuration.platforms.bilibili.format = '[点歌?] {song} !';
  assert.equal(validateSettings(configuration).platforms.bilibili.format, '[点歌?] {song} !');
  assert.equal(matchFormat('[点歌?] 海阔天空 - Beyond !', configuration.platforms.bilibili.format), '海阔天空 - Beyond');
  assert.equal(matchFormat('点歌海阔天空', '点歌 {song}'), '');
  assert.equal(matchFormat('点歌 ', '点歌 {song}'), '');
  assert.equal(matchFormat('点歌+海阔天空+Beyond', '点歌 {song}'), '海阔天空+Beyond');
  assert.equal(matchFormat(' 点歌 ＋ 海阔天空 ＋ Beyond ', '点歌 {song}'), '海阔天空 ＋ Beyond');
  assert.equal(matchFormat('点歌+海阔天空+Beyond', '[点歌?] {song} !'), '');
  for (const format of ['{song}{song}', '点歌', '{song} {user}', '{song}{']) {
    assert.throws(() => validateSettings({ ...configuration, platforms: platformSettings({ format }) }), /格式/);
  }
});

test('invalid settings and failed persistence retain settings atomically', t => {
  const { engine, directory } = setup(t);
  const original = engine.snapshot().settings;
  const saved = fs.readFileSync(path.join(directory, 'song-requests.json'), 'utf8');
  for (const invalid of [{ volume: 2 }, { maxQueue: Infinity }, { enabled: 'true' }, { musicProvider: 'unknown' },
    { platforms: platformSettings({ gifts: [creditRule, creditRule] }) }]) {
    assert.throws(() => engine.configure({ ...original, ...invalid }));
    assert.deepEqual(engine.snapshot().settings, original);
    assert.equal(fs.readFileSync(path.join(directory, 'song-requests.json'), 'utf8'), saved);
  }
  const persist = engine.persist;
  engine.persist = () => { throw new Error('disk full'); };
  assert.throws(() => engine.configure({ ...original, volume: 0.3 }), /disk full/);
  assert.deepEqual(engine.snapshot().settings, original); engine.persist = persist;
});

test('local imports copy files, persist metadata, search artist/song, and hide all paths', async t => {
  const { engine, directory, backend } = setup(t);
  const source = path.join(directory, 'Beyond - 海阔天空.mp3'); fs.writeFileSync(source, 'audio bytes');
  engine.importFiles([source]); fs.rmSync(source);
  const library = engine.snapshot().library;
  assert.equal(library[0].title, '海阔天空'); assert.equal(library[0].artist, 'Beyond');
  assert.equal(library[0].missing, false); assert.equal(library[0].file, undefined);
  assert.equal((await engine.search('海阔天空 - Beyond'))[0].id, library[0].id);
  assert.equal((await engine.enqueueTrack({ ...library[0], file: 'C:/injected.mp3' }, { manual: true })).accepted, true);
  engine.playNext(); await nextTurn();
  assert.equal(path.dirname(backend.plays[0].file), path.join(directory, 'music'));
  assert.equal(backend.plays[0].volume, 0.6); assert.equal(backend.plays[0].device, 'default');
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /injected|furry-song-|\.mp3/);
  const loaded = new SongRequests({ directory, backend });
  assert.deepEqual(loaded.snapshot().library, library); await loaded.dispose();
});

test('volume updates affect the current song immediately and failed saves retain the audible level', async t => {
  const { engine, backend, directory } = setup(t);
  const file = path.join(directory, 'volume.mp3'); fs.writeFileSync(file, 'fixture');
  engine.importFiles([file]); await engine.enqueueTrack(engine.snapshot().library[0], { manual: true });
  engine.playNext(); await nextTurn();
  const id = backend.plays[0].id;
  engine.configure({ ...engine.settings, volume: 0.2 });
  assert.deepEqual(backend.volumeChanges, [{ id, volume: 0.2 }]);
  const persist = engine.persist; engine.persist = () => { throw new Error('disk full'); };
  assert.throws(() => engine.configure({ ...engine.settings, volume: 0.1 }), /disk full/);
  assert.equal(backend.volumeChanges.length, 1); assert.equal(engine.settings.volume, 0.2);
  engine.persist = persist;
});

test('import validates the entire batch and local enqueue never trusts an arbitrary path', async t => {
  const { engine, directory } = setup(t);
  const valid = path.join(directory, 'first.wav'), invalid = path.join(directory, 'second.txt');
  fs.writeFileSync(valid, 'audio'); fs.writeFileSync(invalid, 'not audio');
  assert.throws(() => engine.importFiles([valid, invalid]), /格式/);
  assert.equal(engine.snapshot().library.length, 0); assert.deepEqual(fs.readdirSync(path.join(directory, 'music')), []);
  assert.equal((await engine.enqueueTrack({ id: 'unknown', provider: 'local', title: 'x', artist: '', file: valid }, { manual: true })).accepted, false);
});

test('four platforms have independent formats and enable switches; preview does nothing', async t => {
  const providers = { search: async (provider, query) => [song(query, query, provider)] };
  const platforms = defaults().platforms;
  for (const [index, platform] of Object.keys(platforms).entries()) platforms[platform].format = `${index} {song}`;
  platforms.douyin.enabled = false;
  const { engine } = setup(t, { providers, settings: { musicProvider: 'qq', platforms } });
  for (const [index, platform] of Object.keys(platforms).entries()) {
    const result = await engine.accept(comment(`${index} song-${index}`, `event-${index}`, { ...viewer, platform }));
    assert.equal(result.accepted, platform !== 'douyin');
  }
  const before = engine.snapshot().queue.length;
  assert.equal((await engine.accept({ ...comment('0 preview'), preview: true })).accepted, false);
  assert.equal(engine.snapshot().queue.length, before);
});

test('partial delta gift counts grant credits once and require actual user IDs', async t => {
  const providers = { search: async (provider, query) => [song(query, query, provider)] };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'netease', platforms: platformSettings({ giftRequired: true, gifts: [{ ...creditRule, minCount: 3 }] }) } });
  assert.equal((await engine.accept(gift(2, 'first'))).credits, 0);
  assert.equal((await engine.accept(comment('点歌 a'))).accepted, false);
  assert.equal((await engine.accept(gift(2, 'second'))).credits, 1);
  assert.equal((await engine.accept(gift(2, 'second'))).accepted, false);
  assert.equal((await engine.accept(comment('点歌 a'))).accepted, true);
  assert.equal((await engine.accept(comment('点歌 b'))).accepted, false);
  assert.equal((await engine.accept(gift(2, 'third'))).credits, 1);
  const missingId = { ...viewer, user_id: '' };
  assert.equal((await engine.accept(gift(100, 'anonymous', missingId))).accepted, false);
  assert.equal((await engine.accept(comment('点歌 b', 'impersonation', missingId))).accepted, false);
  assert.equal((await engine.accept(comment('点歌 b'))).accepted, true);
});

test('gift ID rules never fall back to a name; explicit name-only rules match exactly', async t => {
  const { engine } = setup(t, { settings: { platforms: platformSettings({ gifts: [creditRule] }) } });
  assert.equal((await engine.accept(gift(1, 'wrong-id', viewer, { gift_id: 'other' }))).accepted, false);
  assert.equal((await engine.accept(gift(1, 'right-id', viewer, { gift_name: 'renamed gift' }))).credits, 1);
  engine.configure({ ...engine.settings, platforms: platformSettings({ gifts: [{ ...creditRule, giftId: '' }] }) });
  assert.equal((await engine.accept(gift(1, 'name'))).credits, 1);
  assert.equal((await engine.accept(gift(1, 'substring', viewer, { gift_name: '超级小花' }))).accepted, false);
});

test('gift credits are scoped to platform, room and expiry, with bounded count values', async t => {
  let time = 1000;
  const providers = { search: async (provider, query) => [song(query, query, provider)] };
  const platforms = defaults().platforms;
  for (const platform of Object.keys(platforms)) platforms[platform] = { ...platforms[platform], giftRequired: true, gifts: [creditRule] };
  const { engine } = setup(t, { providers, now: () => time, settings: { musicProvider: 'netease', platforms, creditExpiryMinutes: 1 } });
  assert.equal((await engine.accept(gift(1000))).credits, 100);
  for (const extra of [{ gift_count: Infinity }, { gift_count: 1_000_001 }, { gift_count: 1.5 }, { count_mode: 'snapshot' }])
    assert.equal((await engine.accept(gift(1, crypto.randomUUID(), viewer, extra))).accepted, false);
  assert.equal((await engine.accept(comment('点歌 a', 'room-other', { ...viewer, room_id: 'other' }))).accepted, false);
  assert.equal((await engine.accept(comment('点歌 a', 'platform-other', { ...viewer, platform: 'douyin' }))).accepted, false);
  time += 60_001;
  assert.equal((await engine.accept(comment('点歌 a'))).accepted, false);
});

test('fixed-song gifts accumulate thresholds and enqueue their configured query', async t => {
  const searches = [];
  const providers = { search: async (provider, query) => { searches.push(query); return [{ ...song('beyond-song', '海阔天空', provider), artist: 'Beyond' }]; } };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'qq', platforms: platformSettings({ giftRequired: true,
    gifts: [{ ...creditRule, minCount: 2, mode: 'fixed', song: '海阔天空 - Beyond' }] }) } });
  assert.equal((await engine.accept(gift(1))).requests, 0);
  assert.equal((await engine.accept(gift(1))).requests, 1);
  assert.deepEqual(searches, ['海阔天空 Beyond']);
  assert.equal(engine.snapshot().queue[0].query, '海阔天空 - Beyond');
});

test('pending searches reserve capacity and preserve arrival order despite reverse completion', async t => {
  const slow = deferred(), fast = deferred();
  const { engine } = setup(t, { providers: { search: (provider, query) => query === 'first' ? slow.promise : fast.promise }, settings: { musicProvider: 'netease', maxQueue: 2 } });
  const first = engine.request('first', viewer), second = engine.request('second', { ...viewer, user_id: 'bob' });
  assert.equal(engine.snapshot().queue.length, 2);
  assert.equal((await engine.request('third', { ...viewer, user_id: 'carol' })).reason, '点歌队列已满');
  fast.resolve([song('second')]); await nextTurn();
  assert.equal(engine.snapshot().queue[1].track, null, 'later search waits for prior admission');
  slow.resolve([song('first')]);
  assert.equal((await first).accepted, true); assert.equal((await second).accepted, true);
  assert.deepEqual(engine.snapshot().queue.map(item => item.track.id), ['first', 'second']);
});

test('duplicate decisions use track ID in arrival order and allow a different recording on another provider', async t => {
  const slow = deferred(), fast = deferred();
  const { engine } = setup(t, { providers: { search: (provider, query) => query === 'first' ? slow.promise : fast.promise }, settings: { musicProvider: 'netease' } });
  const first = engine.request('first', viewer), second = engine.request('second', { ...viewer, user_id: 'bob' });
  fast.resolve([song('same', 'second')]); await nextTurn(); slow.resolve([song('same', 'first')]);
  assert.equal((await first).accepted, true); assert.equal((await second).accepted, false);
  assert.equal((await engine.enqueueTrack(song('same', 'same', 'qq'), { manual: true })).accepted, true);
});

test('cooldown reserves synchronously and a failed search releases its reservation and credit', async t => {
  const failed = deferred(); let searches = 0;
  const providers = { search: (provider, query) => ++searches === 1 ? failed.promise : Promise.resolve([song(query)]) };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'netease', cooldownSeconds: 30,
    platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(1));
  const first = engine.request('first', viewer);
  assert.equal((await engine.request('second', viewer)).reason, '点歌冷却中');
  failed.reject(new Error('https://private.example/token=secret'));
  assert.equal((await first).accepted, false);
  assert.equal((await engine.request('second', viewer)).accepted, true);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /secret|private\.example/);
});

test('duplicate search failures refund the consumed gift entitlement', async t => {
  const providers = { search: async (provider, query) => [song(query === 'next' ? 'next' : 'same', query)] };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'netease', platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(2));
  assert.equal((await engine.request('first', viewer)).accepted, true);
  assert.equal((await engine.request('duplicate', viewer)).accepted, false);
  assert.equal((await engine.request('next', viewer)).accepted, true);
});

test('a late search failure cannot restore gift entitlements invalidated by new rules', async t => {
  const failed = deferred();
  const { engine } = setup(t, { providers: { search: () => failed.promise }, settings: { musicProvider: 'netease',
    platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(1)); const first = engine.request('first', viewer); await nextTurn();
  engine.configure({ ...engine.settings, platforms: platformSettings({ giftRequired: true, gifts: [{ ...creditRule, minCount: 10 }] }) });
  failed.reject(new Error('old request failed'));
  assert.equal((await first).accepted, false);
  assert.equal((await engine.request('second', viewer)).reason, '请先送出指定点歌礼物');
});

test('disabling during a pending search retains accepted queue order without starting playback', async t => {
  const search = deferred();
  const providers = { search: () => search.promise, resolve: async () => ({ url: 'https://music.example/song.mp3' }) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true } });
  const request = engine.request('first', viewer); await nextTurn();
  engine.configure({ ...engine.settings, enabled: false }); search.resolve([song('first')]);
  assert.equal((await request).accepted, true); await nextTurn(); assert.equal(backend.plays.length, 0);
  assert.equal(engine.snapshot().queue[0].track.id, 'first');
  engine.configure({ ...engine.settings, enabled: true }); await nextTurn(); assert.equal(backend.plays.length, 1);
});

test('disabling during a pending audio resolve prevents late background playback', async t => {
  const media = deferred();
  const providers = { search: async (provider, query) => [song(query)], resolve: () => media.promise };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true } });
  await engine.request('first', viewer); await nextTurn();
  engine.configure({ ...engine.settings, enabled: false });
  media.resolve({ url: 'https://music.example/song.mp3' }); await nextTurn();
  assert.equal(engine.current, null); assert.equal(backend.plays.length, 0);
});

test('playback is serial, honors separate output settings, and rejects currently playing duplicates', async t => {
  const providers = { search: async (provider, query) => [song(query)], resolve: async track => ({ url: `https://music.example/${track.id}.mp3`, duration: 300 }) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true, volume: 0.25, device: 'music-device' } });
  await engine.request('first', viewer); await engine.request('second', { ...viewer, user_id: 'bob' }); await nextTurn();
  assert.equal(backend.plays.length, 1); assert.equal(backend.plays[0].volume, 0.25); assert.equal(backend.plays[0].device, 'music-device');
  assert.equal(backend.plays[0].timeoutMs, 360_000);
  assert.equal((await engine.request('first', { ...viewer, user_id: 'carol' })).accepted, false);
  backend.finish(backend.plays[0].id); await nextTurn();
  assert.equal(backend.plays.length, 2); assert.equal(engine.snapshot().current.track.id, 'second');
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /https:|music\.example/);
});

test('skip cancels a pending resolve even when the provider ignores AbortSignal', async t => {
  const stale = deferred();
  const providers = { search: async (provider, query) => [song(query)], resolve: track => track.id === 'first' ? stale.promise : Promise.resolve({ url: 'https://music.example/second.mp3' }) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true } });
  await engine.request('first', viewer); await engine.request('second', { ...viewer, user_id: 'bob' }); await nextTurn();
  engine.skip(); await nextTurn();
  assert.equal(backend.plays.length, 1); assert.match(backend.plays[0].url, /second/);
  stale.resolve({ url: 'https://music.example/first.mp3?token=secret' }); await nextTurn();
  assert.equal(backend.plays.length, 1); assert.equal(engine.current.track.id, 'second');
});

test('pause retains current audio and resumes it; emergency blocks further triggers until resume', async t => {
  const providers = { search: async (provider, query) => [song(query)], resolve: async () => ({ url: 'https://music.example/song.mp3' }) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true } });
  await engine.request('first', viewer); await nextTurn();
  const id = engine.current.id; engine.pause(true);
  assert.equal(engine.current.id, id); assert.deepEqual(backend.pauses.at(-1), { id, value: true });
  assert.equal((await engine.request('second', { ...viewer, user_id: 'bob' })).accepted, true);
  engine.pause(false); assert.deepEqual(backend.pauses.at(-1), { id, value: false });
  engine.emergency();
  assert.equal(engine.current, null); assert.equal(engine.queue.length, 0); assert.equal(engine.paused, true);
  assert.equal((await engine.accept(comment('点歌 third'))).accepted, false);
  engine.pause(false); assert.equal((await engine.accept(comment('点歌 third'))).accepted, true);
});

test('pausing during online resolution creates initially paused audio without a play-then-pause race', async t => {
  const resolved = deferred();
  const providers = { search: async (provider, query) => [song(query)], resolve: () => resolved.promise };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true, device: 'music-device' } });
  await engine.request('first', viewer); await nextTurn();
  engine.pause(true);
  assert.equal(backend.plays.length, 0);
  resolved.resolve({ url: 'https://music.example/song.mp3' }); await nextTurn();
  assert.equal(backend.plays.length, 1); assert.equal(backend.plays[0].paused, true);
  assert.equal(engine.snapshot().current.stage, '已暂停');
  engine.pause(false);
  assert.deepEqual(backend.pauses.at(-1), { id: backend.plays[0].id, value: false });
  assert.equal(backend.plays.length, 1, 'resume uses the same audio task');
});

test('removing a pending admission refunds credit and drains later resolved requests', async t => {
  const pending = deferred();
  const providers = { search: (provider, query) => query === 'first' ? pending.promise : Promise.resolve([song(query)]) };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'netease', platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(2));
  const first = engine.request('first', viewer), second = engine.request('second', viewer); await nextTurn();
  engine.remove(engine.queue[0].id);
  assert.equal((await first).accepted, false); assert.equal((await second).accepted, true);
  assert.equal((await engine.request('third', viewer)).accepted, true);
  pending.resolve([song('stale')]); await nextTurn();
  assert.deepEqual(engine.queue.map(item => item.track.id), ['second', 'third']);
});

test('off prevents live requests but manual queues and explicit playNext work', async t => {
  const providers = { search: async (provider, query) => [song(query)], resolve: async () => ({ url: 'https://music.example/song.mp3' }) };
  const { engine, backend } = setup(t, { providers, settings: { enabled: false, musicProvider: 'netease', autoPlay: true } });
  assert.equal((await engine.request('live', viewer)).accepted, false);
  assert.equal((await engine.request('manual', { manual: true })).accepted, true); await nextTurn();
  assert.equal(backend.plays.length, 0); engine.playNext(); await nextTurn(); assert.equal(backend.plays.length, 1);
});

test('failed online playback refunds credit and never exposes provider URL credentials or raw errors', async t => {
  const providers = { search: async (provider, query) => [song(query)], resolve: async () => ({ url: 'https://user:secret@music.example/song.mp3' }) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true,
    platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(1)); await engine.request('first', viewer); await nextTurn();
  assert.equal(backend.plays.length, 0); assert.equal(engine.history[0].state, '播放失败');
  engine.configure({ ...engine.settings, autoPlay: false });
  assert.equal((await engine.request('second', viewer)).accepted, true);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /secret|music\.example/);
});

test('trusted provider adapters can return HTTP audio including authorized local gateways', async t => {
  const providers = { search: async (provider, query) => [song(query, query, provider)],
    resolve: async () => ({ url: 'http://127.0.0.1:3200/audio/song.mp3?ticket=private' }) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'qq', autoPlay: true } });
  assert.equal((await engine.request('song', viewer)).accepted, true); await nextTurn();
  assert.equal(backend.plays[0].url, 'http://127.0.0.1:3200/audio/song.mp3?ticket=private');
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /ticket|private|127\.0\.0\.1/);
});

test('dispose cancels pending search and owned playback without disposing a shared backend', async t => {
  const providers = { search: () => new Promise(() => {}) };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease' } });
  let disposedBackend = false; backend.dispose = () => { disposedBackend = true; };
  const request = engine.request('unresponsive', viewer); await nextTurn();
  await engine.dispose(); assert.equal((await request).accepted, false); assert.equal(disposedBackend, false);
  assert.equal(backend.listenerCount('change'), 0); assert.equal((await engine.request('late', viewer)).accepted, false);
});

test('song and artist parsing preserves English titles and exact versions', () => {
  assert.deepEqual(parseSongQuery('Shape of You ＋ Ed Sheeran'), {
    query: 'Shape of You ＋ Ed Sheeran', title: 'Shape of You', artist: 'Ed Sheeran', explicitArtist: true, search: 'Shape of You Ed Sheeran'
  });
  const original = { ...song('original', 'Shape of You'), artist: 'Ed Sheeran' };
  const results = [
    { ...original, id: 'cover', artist: 'Cover Artist' },
    { ...original, id: 'live', title: 'Shape of You (Live)' },
    original
  ];
  assert.deepEqual(selectMatchingTracks('Shape of You Ed Sheeran', results), [original]);
  assert.deepEqual(selectMatchingTracks('Shape of You + Ed Sheeran', results), [original]);
  assert.deepEqual(selectMatchingTracks('Shape of You + Unknown Artist', results), []);
  assert.deepEqual(selectMatchingTracks('Shape + Ed Sheeran', results), []);
  assert.deepEqual(selectMatchingTracks('Shape of You (Live) + Ed Sheeran', results), [results[1]]);
  assert.throws(() => selectMatchingTracks('Shape of You', results), { code: 'SONG_AMBIGUOUS' });
  for (const malformed of ['Song+', '+Artist', 'Song+Artist+Other']) assert.throws(() => parseSongQuery(malformed), { code: 'SONG_QUERY_INVALID' });
});

test('an artist name matches complete performer names, never a substring', () => {
  const tracks = [{ ...song('duet', '晴天'), artist: '周杰伦 / 阿信' }, { ...song('cover', '晴天'), artist: '周杰伦翻唱团' }];
  assert.deepEqual(selectMatchingTracks('晴天+周杰伦', tracks), [tracks[0]]);
  assert.deepEqual(selectMatchingTracks('晴天 周杰伦', tracks), [tracks[0]]);
  assert.deepEqual(selectMatchingTracks('晴天+周杰', tracks), []);
});

test('live song requests accept the real Netease live title with space and plus syntax', async t => {
  const live = { id: '1840192925', provider: 'netease', title: '海底（Live）', artist: '凤凰传奇' };
  const searches = [];
  const providers = {
    snapshot: () => ({ netease: { configured: true } }),
    search: async (provider, query) => {
      searches.push({ provider, query });
      return [
        { id: '1430583016', provider, title: '海底', artist: '一支榴莲' },
        { id: '1859773944', provider, title: '海底(凤凰传奇版)', artist: '光年倚老 / 纱布' },
        live
      ];
    }
  };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'auto' } });
  for (const command of ['点歌 海底 凤凰传奇', '点歌+海底+凤凰传奇', '点歌 ＋ 海底 ＋ 凤凰传奇']) {
    assert.equal((await engine.accept(comment(command))).accepted, true, command);
    assert.deepEqual(engine.queue[0].track, live, 'keep the real version title and trusted provider ID');
    engine.clearQueue();
  }
  assert.deepEqual(searches, Array.from({ length: 3 }, () => ({ provider: 'netease', query: '海底 凤凰传奇' })));
});

test('only plain bracketed Live and live-version suffixes can be alternatives', () => {
  for (const title of ['海底（Live）', '海底 (live)', '海底（现场版）', '海底(现场版)']) {
    const track = { ...song('live', title), artist: '凤凰传奇' };
    assert.deepEqual(selectMatchingTracks('海底+凤凰传奇', [track]), [track], title);
    assert.deepEqual(selectMatchingTracks('海底 凤凰传奇', [track]), [track], title);
  }
  const english = { ...song('english', 'Shape of You (Live)'), artist: 'Ed Sheeran' };
  assert.deepEqual(selectMatchingTracks('Shape of You Ed Sheeran', [english]), [english]);
  assert.deepEqual(selectMatchingTracks('Shape of You', [english]), [], 'a title alone cannot authorize a live alternative');
});

test('exact requested versions take precedence and are never replaced by another version', () => {
  const studio = { ...song('studio', '海底'), artist: '凤凰传奇' };
  const live = { ...studio, id: 'live', title: '海底（Live）' };
  const chineseLive = { ...studio, id: 'chinese-live', title: '海底（现场版）' };
  for (const query of ['海底+凤凰传奇', '海底 凤凰传奇']) {
    assert.deepEqual(selectMatchingTracks(query, [live, chineseLive, studio]), [studio]);
  }
  for (const query of ['海底（Live）+凤凰传奇', '海底（Live） 凤凰传奇']) {
    assert.deepEqual(selectMatchingTracks(query, [studio, chineseLive, live]), [live]);
    assert.deepEqual(selectMatchingTracks(query, [studio, chineseLive]), []);
  }
  const remix = { ...studio, id: 'remix', title: '海底 (Remix)' };
  assert.deepEqual(selectMatchingTracks('海底 (Remix)+凤凰传奇', [live, remix]), [remix]);
  assert.deepEqual(selectMatchingTracks('海底 (Remix)+凤凰传奇', [{ ...remix, title: '海底 (Remix) (Live)' }]), []);
});

test('live alternatives reject other performers, covers, instrumentals, and mixed version labels', () => {
  const live = { ...song('live', '海底（Live）'), artist: '凤凰传奇' };
  for (const artist of ['一支榴莲', '凤凰传奇翻唱团', '凤凰传奇 / 其他歌手', '']) {
    assert.deepEqual(selectMatchingTracks('海底+凤凰传奇', [{ ...live, artist }]), [], artist);
  }
  assert.deepEqual(selectMatchingTracks('海底+凤凰', [live]), []);
  assert.deepEqual(selectMatchingTracks('海底', [live]), []);
  for (const title of ['海底（cover 凤凰传奇）', '海底（Remix）', '海底（伴奏）', '海底（抖音版）',
    '海底（Live Remix）', '海底（Live at 北京）', '海底（伴奏）（Live）', '海底（Live）（Live）',
    '海底 Remix (Live)', '海底 伴奏（Live）', '海底 Live', '海底【Live】']) {
    assert.deepEqual(selectMatchingTracks('海底+凤凰传奇', [{ ...live, title }]), [], title);
  }
});

test('multiple live recordings remain ambiguous even when their displayed titles are identical', () => {
  const live = { ...song('live', '海底（Live）'), artist: '凤凰传奇' };
  for (const other of [
    { ...live, id: 'another-recording' },
    { ...live, id: 'chinese-live', title: '海底（现场版）' }
  ]) {
    assert.throws(() => selectMatchingTracks('海底 凤凰传奇', [live, other]), { code: 'SONG_AMBIGUOUS' });
  }
  assert.deepEqual(selectMatchingTracks('海底 凤凰传奇', [live, { ...live }]), [live]);
});

test('live + commands select the matching singer even when a wrong version is returned first', async t => {
  const searches = [];
  const providers = { search: async (provider, query) => {
    searches.push(query);
    return [{ ...song('wrong', '晴天', provider), artist: '翻唱歌手' }, { ...song('correct', '晴天', provider), artist: '周杰伦' }];
  } };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'qq' } });
  const result = await engine.accept(comment('点歌+晴天+周杰伦'));
  assert.equal(result.accepted, true);
  assert.equal(engine.queue[0].track.id, 'correct');
  assert.deepEqual(searches, ['晴天 周杰伦']);
  engine.clearQueue();
  assert.equal((await engine.accept(comment('点歌 晴天 周杰伦'))).accepted, true);
  assert.equal(engine.queue[0].track.id, 'correct');
});

test('ambiguous or unrelated search results are rejected and release queue capacity and gift credit', async t => {
  const providers = { search: async (provider, query) => query === 'wrong' ? [song('unrelated')] :
    [{ ...song('original', '晴天'), artist: '周杰伦' }, { ...song('cover', '晴天'), artist: '翻唱歌手' }] };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'netease', maxQueue: 1,
    platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(1));
  assert.match((await engine.accept(comment('点歌 晴天'))).reason, /歌手/);
  assert.match((await engine.accept(comment('点歌 wrong'))).reason, /完全匹配/);
  assert.equal(engine.queue.length, 0);
  assert.equal((await engine.accept(comment('点歌+晴天+周杰伦'))).accepted, true);
});

test('auto searches only configured services, tolerates failures, and prefers local matches', async t => {
  const searches = [];
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true }, qishui: { configured: false } }),
    search: async (provider, query) => {
      searches.push({ provider, query });
      if (provider === 'netease') throw new Error('service unavailable');
      return [{ ...song('remote', '晴天', provider), artist: '周杰伦' }];
    }
  };
  const { engine, directory } = setup(t, { providers, settings: { musicProvider: 'auto' } });
  const file = path.join(directory, '周杰伦 - 晴天.mp3'); fs.writeFileSync(file, 'audio');
  engine.importFiles([file]);
  assert.equal((await engine.accept(comment('点歌+晴天+周杰伦'))).accepted, true);
  assert.equal(engine.queue[0].track.provider, 'local');
  assert.deepEqual(searches, [{ provider: 'netease', query: '晴天 周杰伦' }, { provider: 'qq', query: '晴天 周杰伦' }]);
  assert.deepEqual(engine.queue[0].candidates.map(track => track.provider), ['local', 'qq']);
});

test('auto fallback keeps the same song and singer, advances after all sources fail, and refunds entitlement', async t => {
  const resolves = [];
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true }, qishui: { configured: true } }),
    search: async (provider, query) => query.startsWith('晴天') ? [
      { ...song(`${provider}-cover`, '晴天', provider), artist: '翻唱歌手' },
      { ...song(`${provider}-original`, '晴天', provider), artist: '周杰伦' }
    ] : [song(`${provider}-next`, query, provider)],
    resolve: async track => {
      resolves.push(`${track.provider}:${track.title}`);
      if (track.provider === 'netease' || track.provider === 'qishui') throw new Error('not playable');
      return { url: 'https://music.example/song.mp3' };
    }
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true,
    platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(2));
  await engine.accept(comment('点歌+晴天+周杰伦'));
  await engine.accept(comment('点歌 next'));
  await nextTurn();
  assert.equal(backend.plays.length, 1);
  assert.equal(engine.current.track.provider, 'qq');
  assert.equal(engine.current.track.artist, '周杰伦');
  backend.finish(backend.plays[0].id, { error: 'decode failed' }); await nextTurn();
  assert.deepEqual(resolves, ['netease:晴天', 'qq:晴天', 'qishui:晴天', 'netease:next', 'qq:next']);
  assert.equal(backend.plays.length, 2);
  assert.equal(engine.current.track.title, 'next');
  assert.equal(engine.history.find(item => item.label === '晴天').state, '播放失败');
  engine.configure({ ...engine.settings, autoPlay: false });
  assert.equal((await engine.accept(comment('点歌 third'))).accepted, true, 'all-source failure refunds the first gift ticket');
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /music\.example|decode failed|not playable/);
});

test('a failed source moves to the next one and a completed fallback advances the serial queue', async t => {
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true } }),
    search: async (provider, query) => [song(`${provider}-${query}`, query, provider)],
    resolve: async track => {
      if (track.provider === 'netease') throw new Error('membership unavailable');
      return { url: 'https://music.example/song.mp3' };
    }
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true } });
  await engine.request('first', viewer); await engine.request('second', viewer); await nextTurn();
  assert.equal(engine.current.track.provider, 'qq'); assert.equal(backend.plays.length, 1);
  backend.finish(backend.plays[0].id); await nextTurn();
  assert.equal(engine.current.track.title, 'second'); assert.equal(backend.plays.length, 2);
  assert.equal(engine.history[0].state, '已播放');
});

test('skip during auto fallback cancels every remaining source and ignores stale completion', async t => {
  const delayed = deferred(), resolves = [];
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true }, qishui: { configured: true } }),
    search: async (provider, query) => [song(`${provider}-${query}`, query, provider)],
    resolve: async track => {
      resolves.push(`${track.provider}:${track.title}`);
      if (track.title === 'first' && track.provider === 'netease') throw new Error('unavailable');
      if (track.title === 'first') return delayed.promise;
      return { url: 'https://music.example/second.mp3' };
    }
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true } });
  await engine.request('first', viewer); await engine.request('second', viewer); await nextTurn();
  assert.equal(engine.current.track.provider, 'qq');
  engine.skip(); await nextTurn();
  delayed.resolve({ url: 'https://music.example/stale.mp3' }); await nextTurn();
  assert.equal(engine.current.track.title, 'second'); assert.equal(backend.plays.length, 1);
  assert.deepEqual(resolves, ['netease:first', 'qq:first', 'netease:second']);
});

test('removing or clearing accepted songs returns unused gift tickets', async t => {
  const providers = { search: async (provider, query) => [song(query, query, provider)] };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'qq',
    platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(1));
  await engine.request('first', viewer); engine.remove(engine.queue[0].id);
  assert.equal((await engine.request('second', viewer)).accepted, true);
  engine.clearQueue();
  assert.equal((await engine.request('third', viewer)).accepted, true);
  assert.equal(engine.history.filter(item => item.state === '已取消').length, 2);
});

test('the same recording is deduplicated across providers, including after a current song switches source', async t => {
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true } }),
    search: async (provider, query) => [song(`${provider}-${query}`, query, provider)],
    resolve: async track => {
      if (track.provider === 'netease') throw new Error('unavailable');
      return { url: 'https://music.example/song.mp3' };
    }
  };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true } });
  assert.equal((await engine.request('first', viewer)).accepted, true); await nextTurn();
  assert.equal(engine.current.track.provider, 'qq');
  assert.match((await engine.request('first', { ...viewer, user_id: 'bob' })).reason, /已在队列或正在播放/);
  assert.equal((await engine.enqueueTrack({ ...song('other-provider-id', 'ＦＩＲＳＴ', 'netease') }, { manual: true })).accepted, false);
  assert.equal((await engine.enqueueTrack({ ...song('cover', 'first', 'netease'), artist: '另一歌手' }, { manual: true })).accepted, true);
});

test('auto distinguishes unavailable services from a successful search with no matching song', async t => {
  let offline = true;
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true } }),
    search: async () => { if (offline) throw new Error('private service URL'); return []; }
  };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'auto' } });
  assert.match((await engine.request('first', viewer)).reason, /搜索失败/);
  offline = false;
  assert.match((await engine.request('first', viewer)).reason, /未找到/);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /private service/);
});

test('cancelling from a playback-stage observer cannot start late audio or retry another source', async t => {
  const providers = {
    snapshot: () => ({ netease: { configured: true }, qq: { configured: true } }),
    search: async (provider, query) => [song(`${provider}-${query}`, query, provider)],
    resolve: async () => ({ url: 'https://music.example/song.mp3' })
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true } });
  let stopped = false;
  engine.on('change', () => {
    if (!stopped && engine.current?.stage === '正在加载音频') { stopped = true; engine.emergency(); }
  });
  await engine.request('first', viewer); await nextTurn();
  assert.equal(engine.current, null);
  assert.equal(backend.plays.length, 0);
});

test('known song duration reaches the audio backend even when the resolved URL omits it', async t => {
  const providers = {
    search: async (provider, query) => [{ ...song(query, query, provider), duration: 240 }],
    resolve: async () => ({ url: 'https://music.example/song.mp3' })
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'qq', autoPlay: true } });
  await engine.request('first', viewer); await nextTurn();
  assert.equal(backend.plays[0].duration, 240, 'renderer can reject short trial audio against the known full duration');
});

test('queued provider tracks stay retained until rejection, removal, clearing, skip, playback end, or disposal', async t => {
  const retained = new Map();
  const providers = {
    search: async (provider, query) => [song(query, query, provider)],
    resolve: async () => ({ url: 'https://music.example/song.mp3' }),
    retainTracks: (owner, tracks) => retained.set(owner, tracks),
    releaseTracks: owner => retained.delete(owner)
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'qq' } });
  await engine.request('first', viewer);
  assert.equal(retained.has(engine.queue[0].id), true);
  assert.equal((await engine.request('first', viewer)).accepted, false);
  assert.equal(retained.size, 1, 'duplicate rejection releases its own retained group only');
  await engine.request('second', viewer);
  engine.remove(engine.queue[0].id);
  assert.equal(retained.size, 1);
  engine.clearQueue(); assert.equal(retained.size, 0);
  await engine.request('third', viewer); engine.playNext(); await nextTurn();
  const id = engine.current.id; assert.equal(retained.has(id), true);
  backend.finish(id); await nextTurn(); assert.equal(retained.size, 0);
  await engine.request('fourth', viewer); engine.playNext(); await nextTurn();
  engine.skip(); assert.equal(retained.size, 0);
  await engine.request('fifth', viewer); await engine.request('sixth', viewer); engine.playNext(); await nextTurn();
  assert.equal(retained.size, 2);
  await engine.dispose(); assert.equal(retained.size, 0);
});

test('retention failures reject the request and clean partial pins without blocking later requests', async t => {
  const retained = new Map();
  let fail = true;
  const providers = {
    search: async (provider, query) => [song(query, query, provider)],
    retainTracks: (owner, tracks) => { retained.set(owner, tracks); if (fail) throw new Error('cache unavailable'); },
    releaseTracks: owner => retained.delete(owner)
  };
  const { engine } = setup(t, { providers, settings: { musicProvider: 'qq' } });
  assert.match((await engine.request('first', viewer)).reason, /搜索失败/);
  assert.equal(retained.size, 0); assert.equal(engine.queue.length, 0);
  fail = false;
  assert.equal((await engine.request('second', viewer)).accepted, true);
  assert.equal(retained.size, 1);
});

test('pausing a backend without native pause retains the track while it is requeued', async t => {
  const retained = new Map();
  const providers = {
    search: async (provider, query) => [song(query, query, provider)],
    resolve: async () => ({ url: 'https://music.example/song.mp3' }),
    retainTracks: (owner, tracks) => retained.set(owner, tracks),
    releaseTracks: owner => retained.delete(owner)
  };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'qq', autoPlay: true } });
  backend.setPaused = undefined;
  await engine.request('first', viewer); await nextTurn();
  const id = engine.current.id;
  engine.pause(true); await nextTurn();
  assert.equal(engine.queue[0].id, id); assert.equal(retained.has(id), true);
  engine.pause(false); await nextTurn();
  assert.equal(engine.current.id, id); assert.equal(retained.has(id), true);
  backend.finish(id); await nextTurn(); assert.equal(retained.size, 0);
});

test('request diagnostics correlate search, queue, playback and failures without exposing source secrets', async t => {
  let now = 1000;
  const providers = { search: async (provider, query) => [song(query, query, provider)],
    resolve: async () => ({ url: 'https://music.example/song.mp3?token=PRIVATE' }) };
  const { engine, backend } = setup(t, { providers, now: () => now, settings: { musicProvider: 'netease', autoPlay: true } });
  const result = await engine.accept(comment('点歌 first')); await nextTurn();
  now += 1500; backend.emit('playback-started', backend.plays[0].id);
  const during = engine.snapshot().current.diagnostics;
  assert.equal(during.requestId, result.item.id);
  assert.deepEqual(during.steps.map(step => step.stage), ['received', 'searching', 'matched', 'queued', 'resolving', 'loading', 'playing']);
  assert.equal(during.steps.at(-1).elapsedMs, 1500);
  now += 3000; backend.finish(backend.plays[0].id, { error: 'PRIVATE', code: 'AUDIO_INCOMPLETE_SOURCE' }); await nextTurn();
  const after = engine.snapshot().history[0].diagnostics;
  assert.equal(after.requestId, during.requestId);
  assert.equal(after.elapsedMs, 4500);
  assert.equal(after.steps.at(-2).code, 'AUDIO_INCOMPLETE_SOURCE');
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /PRIVATE|https:|token=/);
});

test('next-source preflight waits for playback acknowledgement, prepares only one song and is reused once', async t => {
  const resolved = [], slow = deferred();
  const providers = { sourceRevision: 0,
    search: async (provider, query) => [song(query, query, provider)],
    resolve: async track => { resolved.push(track.id); return track.id === 'second' ? slow.promise : { url: 'https://music.example/ok.mp3' }; } };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'netease', autoPlay: true } });
  for (const query of ['first', 'second', 'third']) await engine.request(query, viewer);
  await nextTurn(); assert.deepEqual(resolved, ['first']);
  backend.emit('playback-started', backend.plays[0].id); await nextTurn();
  assert.deepEqual(resolved, ['first', 'second']);
  assert.equal(backend.plays.length, 1);
  assert.equal(engine.snapshot().queue[0].stage, '正在预检下一首音源');
  backend.finish(backend.plays[0].id); await nextTurn();
  assert.equal(backend.plays.length, 1, 'playback waits for the in-flight preparation instead of resolving twice');
  slow.resolve({ url: 'https://music.example/prepared.mp3?token=SECRET' }); await nextTurn();
  assert.equal(backend.plays.length, 2); assert.equal(engine.current.track.id, 'second');
  assert.deepEqual(resolved, ['first', 'second']);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /SECRET|https:/);
  backend.emit('playback-started', backend.plays[1].id); await nextTurn();
  assert.deepEqual(resolved, ['first', 'second', 'third']);
});

test('expired or reconfigured source preparations are fetched afresh', async t => {
  for (const invalidation of ['time', 'configuration']) await t.test(invalidation, async t => {
    let now = 1000, secondResolves = 0;
    const providers = { sourceRevision: 0, search: async (provider, query) => [song(query, query, provider)],
      resolve: async track => { if (track.id === 'second') secondResolves++; return { url: `https://music.example/${secondResolves}.mp3` }; } };
    const { engine, backend } = setup(t, { providers, now: () => now, settings: { musicProvider: 'netease', autoPlay: true } });
    await engine.request('first', viewer); await engine.request('second', viewer); await nextTurn();
    backend.emit('playback-started', backend.plays[0].id); await nextTurn();
    assert.equal(secondResolves, 1);
    if (invalidation === 'time') now += 30_001; else providers.sourceRevision++;
    backend.finish(backend.plays[0].id); await nextTurn();
    assert.equal(secondResolves, 2); assert.match(backend.plays[1].url, /2.mp3$/);
  });
});

test('preflight selects an available alternate source and cancellation cannot play its late result', async t => {
  const calls = [], late = deferred(); let cancelled = false;
  const providers = { snapshot: () => ({ netease: { configured: true }, qq: { configured: true } }),
    search: async (provider, query) => [song(`${provider}-${query}`, query, provider)],
    resolve: async (track, { signal }) => {
      calls.push(track.id);
      if (track.title === 'second' && track.provider === 'netease') throw Object.assign(new Error('SECRET'), { code: 'MUSIC_TRIAL_ONLY' });
      if (track.title === 'third') { signal.addEventListener('abort', () => { cancelled = true; }); return late.promise; }
      return { url: 'https://music.example/ok.mp3' };
    } };
  const { engine, backend } = setup(t, { providers, settings: { musicProvider: 'auto', autoPlay: true } });
  for (const query of ['first', 'second', 'third']) await engine.request(query, viewer);
  await nextTurn(); backend.emit('playback-started', backend.plays[0].id); await nextTurn();
  assert.deepEqual(calls, ['netease-first', 'netease-second', 'qq-second']);
  backend.finish(backend.plays[0].id); await nextTurn();
  assert.equal(engine.current.track.provider, 'qq'); assert.equal(calls.length, 3);
  backend.emit('playback-started', backend.plays[1].id); await nextTurn();
  engine.clearQueue(); assert.equal(cancelled, true);
  late.resolve({ url: 'https://music.example/late.mp3' }); await nextTurn();
  assert.equal(backend.plays.length, 2); assert.equal(engine.queue.length, 0);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /SECRET|https:/);
});

test('viewer withdrawal removes only their latest pending request in the same room and platform and refunds its ticket', async t => {
  const pending = deferred();
  const { engine } = setup(t, { providers: { search: async (_provider, query) => query === 'pending' ? pending.promise : [song(query)] },
    settings: { musicProvider: 'netease', platforms: platformSettings({ giftRequired: true, gifts: [creditRule] }) } });
  await engine.accept(gift(1));
  const request = engine.accept(comment('点歌 pending'));
  for (const context of [{ ...viewer, user_id: 'other' }, { ...viewer, room_id: 'other' }, { ...viewer, platform: 'douyin' }, { ...viewer, user_id: '' }]) {
    assert.equal((await engine.accept(comment('撤回点歌', crypto.randomUUID(), context))).accepted, false);
  }
  assert.equal(engine.queue.length, 1);
  const withdraw = comment('撤回点歌');
  assert.equal((await engine.accept(withdraw)).accepted, true);
  assert.equal((await request).accepted, false);
  assert.equal((await engine.accept(comment('点歌 replacement'))).accepted, true, 'unused gift ticket is returned');
  assert.equal((await engine.accept(withdraw)).accepted, false, 'duplicate delivery cannot withdraw another song');
  pending.resolve([song('pending')]); await nextTurn();
  assert.deepEqual(engine.queue.map(item => item.track.id), ['replacement']);
});

test('official aliases match complete names with artist guards and cannot authorize an unspecified remix or cover', () => {
  const aliased = { ...song('translated', '夜に駆ける'), artist: 'YOASOBI', aliases: ['奔向夜空'] };
  assert.deepEqual(selectMatchingTracks('奔向夜空+YOASOBI', [aliased]), [aliased]);
  assert.deepEqual(selectMatchingTracks('奔向夜空+另一歌手', [aliased]), []);
  const exact = { ...aliased, id: 'exact', title: '奔向夜空', aliases: [] };
  assert.deepEqual(selectMatchingTracks('奔向夜空+YOASOBI', [aliased, exact]), [exact]);
  for (const version of ['(Live)', '(Remix)', '(cover)', '伴奏']) {
    assert.deepEqual(selectMatchingTracks('奔向夜空+YOASOBI', [{ ...aliased, title: `${aliased.title} ${version}` }]), []);
  }
  assert.throws(() => selectMatchingTracks('奔向夜空', [aliased, { ...aliased, id: 'other', artist: 'another artist' }]), { code: 'SONG_AMBIGUOUS' });
});
