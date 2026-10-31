'use strict';
const studioNativeI18n = require("./messages.cjs");

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSettingsStore } = require('./settings-store.cjs');
const { AudioFileIndex } = require('./audio-file-index.cjs');
const { importAudio, cancelAudioImport } = require('./audio-import.cjs');
const { audioError } = require('./audio-diagnostics.cjs');
const { createSongTrace, markSongTrace, songTraceSnapshot } = require('./song-diagnostics.cjs');

const PLATFORMS = Object.freeze(['bilibili', 'douyin', 'kuaishou', 'wechat']);
const TRACK_PROVIDERS = Object.freeze(['local', 'netease', 'qq', 'qishui']);
const MUSIC_PROVIDERS = Object.freeze(['auto', ...TRACK_PROVIDERS]);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac']);
const MAX_CREDITS = 100;
const MAX_IDENTITIES = 5000;
const MAX_SEARCH_MS = 30_000;
const clone = value => JSON.parse(JSON.stringify(value));
const clean = (value, max = 128) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const identity = context => context.user_id ? JSON.stringify([context.platform, context.room_id, context.user_id]) : '';
const trackKey = track => JSON.stringify([track.provider, track.id]);
const defaults = () => ({ enabled: false, autoPlay: true, musicProvider: 'local', volume: 0.6, device: 'default',
  maxQueue: 50, cooldownSeconds: 30, duplicatePolicy: true, creditExpiryMinutes: 10,
  platforms: Object.fromEntries(PLATFORMS.map(platform => [platform, { enabled: true, format: '点歌 {song}', giftRequired: false, gifts: [] }])) });

function text(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(studioNativeI18n.tr`${label}无效`);
  return value.trim();
}
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(studioNativeI18n.t('点歌设置无效'));
  const next = defaults();
  for (const key of ['enabled', 'autoPlay', 'duplicatePolicy']) {
    if (typeof value[key] !== 'boolean') throw new Error(studioNativeI18n.t('点歌开关无效'));
    next[key] = value[key];
  }
  for (const [key, min, max, integer] of [['volume', 0, 1, false], ['maxQueue', 1, 200, true],
    ['cooldownSeconds', 0, 3600, true], ['creditExpiryMinutes', 1, 1440, true]]) {
    if (!Number.isFinite(value[key]) || value[key] < min || value[key] > max || (integer && !Number.isInteger(value[key]))) throw new Error(studioNativeI18n.t('点歌参数超出范围'));
    next[key] = value[key];
  }
  if (!MUSIC_PROVIDERS.includes(value.musicProvider)) throw new Error(studioNativeI18n.t('音乐来源无效'));
  next.musicProvider = value.musicProvider;
  next.device = text(value.device, 256, '输出设备');
  for (const platform of PLATFORMS) {
    const input = value.platforms?.[platform];
    if (!input || typeof input.enabled !== 'boolean' || typeof input.giftRequired !== 'boolean') throw new Error(studioNativeI18n.t('平台点歌设置无效'));
    // A format is plain text with precisely one placeholder. It is never compiled as a RegExp.
    const format = text(input.format, 200, '点歌格式');
    if (format.split('{song}').length !== 2 || /[{}]/.test(format.replace('{song}', ''))) throw new Error(studioNativeI18n.t('点歌格式须包含且只包含一个 {song}'));
    if (!Array.isArray(input.gifts) || input.gifts.length > 50) throw new Error(studioNativeI18n.t('每个平台最多设置 50 条点歌礼物'));
    const seen = new Set();
    const gifts = input.gifts.map(gift => {
      if (!gift || typeof gift !== 'object') throw new Error(studioNativeI18n.t('点歌礼物无效'));
      const giftId = text(gift.giftId ?? '', 128, '礼物 ID', true);
      const giftName = text(gift.giftName ?? '', 100, '礼物名称', true);
      if (!giftId && !giftName) throw new Error(studioNativeI18n.t('请填写礼物 ID 或精确名称'));
      if (!Number.isInteger(gift.minCount) || gift.minCount < 1 || gift.minCount > 1_000_000 || !['credit', 'fixed'].includes(gift.mode)) throw new Error(studioNativeI18n.t('点歌礼物数量或模式无效'));
      const song = text(gift.song ?? '', 200, '固定歌曲', gift.mode !== 'fixed');
      const key = giftId ? `id:${giftId}` : `name:${giftName}`;
      if (seen.has(key)) throw new Error(studioNativeI18n.t('同一平台的点歌礼物不能重复'));
      seen.add(key);
      return { giftId, giftName, minCount: gift.minCount, mode: gift.mode, song };
    });
    next.platforms[platform] = { enabled: input.enabled, format, giftRequired: input.giftRequired, gifts };
  }
  return next;
}

function publicTrack(track) {
  if (!track) return null;
  return { id: track.id, provider: track.provider, title: track.title, artist: track.artist,
    ...(Number.isFinite(track.duration) && track.duration >= 0 ? { duration: track.duration } : {}),
    ...(track.aliases?.length ? { aliases: [...track.aliases] } : {}) };
}
function normalizeTrack(value, provider) {
  if (!value || typeof value !== 'object' || !TRACK_PROVIDERS.includes(provider)) throw new Error(studioNativeI18n.t('歌曲信息无效'));
  const id = text(value.id, 200, '歌曲 ID');
  // Public track metadata cannot carry a URL, local path, or provider credentials.
  if (/[/\\?#@]/.test(id)) throw new Error(studioNativeI18n.t('歌曲 ID 无效'));
  return { id, provider, title: text(value.title, 200, studioNativeI18n.t('歌曲名称')), artist: text(value.artist ?? '', 200, '歌手', true),
    ...(Array.isArray(value.aliases) ? { aliases: value.aliases.filter(alias => typeof alias === 'string' && alias.trim() && alias.length <= 200 && !/[\u0000-\u001f\u007f]/.test(alias)).slice(0, 8).map(alias => alias.trim()) } : {}),
    ...(Number.isFinite(value.duration) && value.duration >= 0 && value.duration <= 86_400 ? { duration: value.duration } : {}) };
}
function matchFormat(content, format) {
  if (typeof content !== 'string' || content.length > 1000) return '';
  const [prefix, suffix] = format.split('{song}');
  const message = content.trim();
  // Preserve custom literal formats, while the default command also accepts the familiar + separator.
  if (format === '点歌 {song}' && /^点歌\s*[+＋]/u.test(message)) return message.replace(/^点歌\s*[+＋]\s*/u, '').trim();
  if (!message.startsWith(prefix) || !message.endsWith(suffix) || message.length < prefix.length + suffix.length) return '';
  return message.slice(prefix.length, suffix ? -suffix.length : undefined).trim();
}

const matchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]/gu, '');
const recordingKey = track => JSON.stringify([matchText(track.title), matchText(track.artist)]);
function parseSongQuery(query) {
  const cleaned = text(query, 200, '歌曲搜索');
  const parts = cleaned.split(/\s*[+＋]\s*|\s+[-—–]\s+/u);
  if (parts.length > 2 || parts.some(part => !part.trim())) {
    throw Object.assign(new Error(studioNativeI18n.t('请按“歌名 + 歌手”填写点歌内容')), { code: 'SONG_QUERY_INVALID' });
  }
  const title = parts[0].trim(), artist = parts[1]?.trim() || '';
  return { query: cleaned, title, artist, explicitArtist: parts.length === 2,
    search: artist ? `${title} ${artist}` : title };
}
function artistMatches(actual, requested) {
  const wanted = matchText(requested);
  if (!wanted) return 0;
  if (matchText(actual) === wanted) return 2;
  return String(actual).split(/\s*(?:\/|&|、|,|，|;|；|\bfeat\.?\s+|\bft\.?\s+)\s*/iu)
    .some(artist => matchText(artist) === wanted) ? 1 : 0;
}
function matchesLiveAlternative(track, request) {
  // Only a single, explicit live suffix can be omitted. Other version labels
  // remain part of the title, and live alternatives require the entire artist.
  const title = String(track.title || '').normalize('NFKC').trim();
  const suffix = title.match(/^(.+?)\s*\((?:live|现场版)\)$/iu);
  if (!suffix) return false;
  const versioned = /[\p{Ps}\p{Pe}]|\b(?:live|remix|cover|instrumental|karaoke)\b|现场版|伴奏|纯音乐/iu;
  const base = suffix[1].trim();
  if (versioned.test(base)) return false;
  const matches = (requestedTitle, requestedArtist) => !versioned.test(requestedTitle) &&
    matchText(base) === matchText(requestedTitle) && Boolean(matchText(requestedArtist)) &&
    matchText(track.artist) === matchText(requestedArtist);
  if (request.explicitArtist) return matches(request.title, request.artist);
  const words = request.title.split(/\s+/u);
  for (let split = 1; split < words.length; split++) {
    if (matches(words.slice(0, split).join(' '), words.slice(split).join(' '))) return true;
  }
  return false;
}
function selectMatchingTracks(query, tracks) {
  const request = typeof query === 'string' ? parseSongQuery(query) : query;
  const title = matchText(request.title), words = request.title.split(/\s+/u);
  const rank = (track, name) => {
    const trackTitle = matchText(name);
    let score = 0;
    if (request.explicitArtist) {
      if (trackTitle === title) score = artistMatches(track.artist, request.artist) + 2;
      if (score === 2) score = 0;
    } else {
      if (trackTitle === title) score = 1;
      // Whitespace is ambiguous in English titles. Compare every actual word boundary to metadata.
      for (let split = 1; split < words.length; split++) {
        const artist = artistMatches(track.artist, words.slice(split).join(' '));
        if (matchText(words.slice(0, split).join(' ')) === trackTitle && artist) score = Math.max(score, artist + 2);
      }
    }
    return score;
  };
  // Official titles win over aliases. Alias matching never substitutes an artist
  // and never erases an explicitly requested performance/version label.
  const exactRanked = tracks.map(track => ({ track, score: rank(track, track.title) })).filter(item => item.score > 0);
  const ranked = exactRanked.length ? exactRanked : tracks.map(track => ({ track,
    score: /\b(?:live|remix|cover|instrumental|karaoke)\b|现场版|伴奏|纯音乐/iu.test(track.title) ? 0 :
      Math.max(0, ...(track.aliases || []).map(alias => rank(track, alias))) })).filter(item => item.score > 0);
  const best = Math.max(0, ...ranked.map(item => item.score));
  const exact = ranked.filter(item => item.score === best).map(item => item.track);
  const candidates = (exact.length ? exact : tracks.filter(track => matchesLiveAlternative(track, request)))
    .filter((track, index, all) => all.findIndex(other => trackKey(other) === trackKey(track)) === index);
  const recordings = new Set(candidates.map(recordingKey));
  // Matching live metadata from separate services is useful for fallback. Two
  // recordings within one service or materially different lengths remain ambiguous.
  const lengths = candidates.map(track => track.duration).filter(duration => Number.isFinite(duration) && duration > 0);
  const conflictingLive = !exact.length && (new Set(candidates.map(track => track.provider)).size < candidates.length ||
    (lengths.length > 1 && Math.max(...lengths) - Math.min(...lengths) > 5));
  if (recordings.size > 1 || conflictingLive) {
    throw Object.assign(new Error(studioNativeI18n.t('找到多个同名版本，请补充准确歌手')), { code: 'SONG_AMBIGUOUS' });
  }
  return candidates;
}

function validateStoredSongs(saved) {
  validateSettings(saved.settings);
  if (saved.library !== undefined && (!Array.isArray(saved.library) || saved.library.length > 1000)) throw new Error(studioNativeI18n.t('音乐库格式无效'));
  const ids = new Set();
  for (const item of saved.library || []) {
    const track = normalizeTrack(item, 'local');
    if (!/^[a-f0-9-]{36}$/.test(track.id) || ids.has(track.id) || typeof item.file !== 'string' ||
        path.basename(item.file) !== item.file || item.file !== `${track.id}${path.extname(item.file)}` ||
        !AUDIO_EXTENSIONS.has(path.extname(item.file))) throw new Error(studioNativeI18n.t('音乐库记录格式无效'));
    ids.add(track.id);
  }
}

class SongRequests extends EventEmitter {
  constructor({ directory, backend, providers, now = Date.now, storageIo = fs }) {
    super();
    if (!directory || !backend || typeof backend.play !== 'function' || typeof backend.stop !== 'function') throw new Error(studioNativeI18n.t('点歌音频后台无效'));
    this.directory = directory; this.backend = backend; this.providers = providers; this.now = now;
    this.file = path.join(directory, 'song-requests.json'); this.musicDirectory = path.join(directory, 'music');
    this.settingsStore = createSettingsStore(this.file, storageIo, { validate: validateStoredSongs, label: studioNativeI18n.t('点歌设置与音乐库') });
    this.storageWarning = '';
    this.settings = defaults(); this.library = []; this.queue = []; this.current = null; this.history = [];
    this.paused = false; this.emergencyStopped = false; this.disposed = false; this.seen = new Map();
    this.credits = new Map(); this.creditGeneration = 0; this.recent = new Map(); this.searches = new Set(); this.playbackTasks = new Set(); this.preparations = new Set();
    fs.mkdirSync(this.musicDirectory, { recursive: true });
    this.audioFiles = new AudioFileIndex(this.musicDirectory, { onChange: () => this.changed() });
    let loaded;
    try { loaded = this.settingsStore.read(); }
    catch (error) { throw new Error(studioNativeI18n.t('点歌设置与音乐库无法读取，原文件已保留。请检查目录权限或磁盘后重试。'), { cause: error }); }
    this.storageWarning = loaded.warning;
    if (loaded.source !== 'default') {
      const saved = loaded.value;
      const settings = validateSettings(saved.settings);
      const library = (Array.isArray(saved.library) ? saved.library : []).slice(0, 1000).flatMap(item => {
        try {
          const track = normalizeTrack(item, 'local');
          if (!/^[a-f0-9-]{36}$/.test(track.id) || typeof item.file !== 'string' || path.basename(item.file) !== item.file ||
              item.file !== `${track.id}${path.extname(item.file)}` || !AUDIO_EXTENSIONS.has(path.extname(item.file))) return [];
          return [{ ...track, file: item.file }];
        } catch { return []; }
      });
      this.settings = settings; this.library = library;
    }
    if (this.storageWarning) this.record({ context: {}, query: '设置恢复' }, '请检查', this.storageWarning);
    this.backendChange = () => this.changed();
    this.backend.on?.('change', this.backendChange);
    this.backendStarted = id => {
      if (!this.current || this.current.audioId !== id) return;
      this.current.playbackStarted = true;
      this.mark(this.current, 'playing', this.current.track?.provider);
      this.current.stage = this.paused ? '已暂停' : '正在播放'; this.changed(); this.prepareNext();
    };
    this.backend.on?.('playback-started', this.backendStarted);
    this.backendUnavailable = () => { if (!this.disposed) this.emergency(); };
    this.backend.on?.('unavailable', this.backendUnavailable);
  }
  changed() { if (!this.disposed) this.emit('change'); }
  snapshot() {
    const files = this.audioFiles.snapshot();
    return { storageWarning: this.storageWarning, importing: this.importState ? { ...this.importState } : null, settings: clone(this.settings), library: this.library.map(track => ({ ...publicTrack(track), missing: !files.has(track.file) })),
      queue: this.queue.map(item => this.publicItem(item)), current: this.current ? this.publicItem(this.current) : null,
      history: clone(this.history), paused: this.paused, emergencyStopped: this.emergencyStopped,
      devices: clone(this.backend.devices || []) };
  }
  publicItem(item) {
    return { id: item.id, track: publicTrack(item.track), query: item.query, platform: item.context.platform,
      user_id: item.context.user_id, user_name: item.context.user_name, room_id: item.context.room_id,
      at: item.at, stage: studioNativeI18n.t(item.stage), diagnostics: songTraceSnapshot(item) };
  }
  persist() {
    this.settingsStore.write({ settings: this.settings, library: this.library });
    this.storageWarning = '';
  }
  configure(value) {
    this.ensureOpen();
    const next = validateSettings(value), previous = this.settings;
    this.settings = next;
    try { this.persist(); } catch (error) { this.settings = previous; throw error; }
    if (JSON.stringify(previous.platforms) !== JSON.stringify(next.platforms) || previous.creditExpiryMinutes !== next.creditExpiryMinutes) {
      this.credits.clear(); this.creditGeneration++;
    }
    // A request already accepted uses its admission-time provider/rules. Settings changes do not reorder it.
    if (!next.enabled && previous.enabled) this.stopCurrent('已停止');
    if (this.current && next.volume !== previous.volume) this.backend.setVolume(this.current.audioId || this.current.id, next.volume);
    this.changed(); this.pump(); return this.snapshot();
  }
  ensureOpen() { if (this.disposed) throw new Error(studioNativeI18n.t('点歌服务已关闭')); }
  mark(item, stage, provider, code) { markSongTrace(item, stage, this.now(), provider, code); }
  record(item, state, detail = '') {
    const terminal = { '未加入': 'rejected', '已播放': 'played', '已跳过': 'stopped', '已停止': 'stopped', '已取消': 'cancelled', '播放失败': 'rejected' }[state];
    if (terminal) this.mark(item, terminal);
    this.history.unshift({ id: randomUUID(), at: this.now(), label: item.track?.title || item.query || studioNativeI18n.t('点歌'),
      state, detail, platform: item.context?.platform || 'manual', user_name: item.context?.user_name || '', diagnostics: songTraceSnapshot(item) });
    this.history.length = Math.min(this.history.length, 50); this.changed();
  }
  prepareImports(files) {
    this.ensureOpen();
    if (!Array.isArray(files) || !files.length || files.length > 50 || this.library.length + files.length > 1000) throw new Error(studioNativeI18n.t('每次导入 1～50 首歌曲，曲库最多 1000 首'));
    return files.map(source => {
      if (typeof source !== 'string') throw new Error(studioNativeI18n.t('歌曲文件无效'));
      const extension = path.extname(source).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(extension)) throw new Error(studioNativeI18n.t('不支持的音频格式'));
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 300 * 1024 * 1024) throw new Error(studioNativeI18n.t('歌曲文件须为 0～300 MB 的有效音频'));
      const id = randomUUID(), basename = clean(path.basename(source, path.extname(source)), 400);
      const separator = basename.indexOf(' - ');
      return { source, size: stat.size, id, provider: 'local', title: clean(separator >= 0 ? basename.slice(separator + 3) : basename, 200) || studioNativeI18n.t('未命名歌曲'),
        artist: separator >= 0 ? clean(basename.slice(0, separator), 200) : '', file: `${id}${extension}` };
    });
  }
  importFilesAsync(files) {
    return importAudio(this, { files, prepare: value => this.prepareImports(value), directory: this.musicDirectory, key: 'library', limit: 1000 });
  }
  cancelImport() { cancelAudioImport(this); }
  importFiles(files) {
    if (this.importTask) throw new Error(studioNativeI18n.t('已有导入正在进行'));
    const prepared = this.prepareImports(files);
    const previous = this.library;
    try {
      for (const track of prepared) fs.copyFileSync(track.source, path.join(this.musicDirectory, track.file), fs.constants.COPYFILE_EXCL);
      this.library = [...previous, ...prepared.map(({ source, size, ...track }) => track)]; this.persist();
    } catch (error) {
      this.library = previous;
      for (const track of prepared) try { fs.rmSync(path.join(this.musicDirectory, track.file), { force: true }); } catch { /* Best effort copied-file cleanup. */ }
      throw error;
    }
    this.audioFiles.add(prepared.map(item => item.file));
    this.changed(); return this.snapshot();
  }
  removeTrack(id) {
    this.ensureOpen();
    const track = this.library.find(item => item.id === id);
    if (!track) throw new Error(studioNativeI18n.t('歌曲不存在'));
    const previous = this.library; this.library = this.library.filter(item => item !== track);
    try { this.persist(); } catch (error) { this.library = previous; throw error; }
    for (const item of [...this.queue]) if (item.track?.provider === 'local' && item.track.id === id) this.remove(item.id);
    if (this.current?.track.provider === 'local' && this.current.track.id === id) this.skip();
    try { fs.rmSync(path.join(this.musicDirectory, track.file), { force: true }); this.audioFiles.remove(track.file); } catch { /* File may still be held by the audio backend. */ }
    this.changed(); return this.snapshot();
  }
  async search(query, provider = this.settings.musicProvider, { signal, onSource } = {}) {
    this.ensureOpen();
    const cleaned = parseSongQuery(query).search;
    if (!MUSIC_PROVIDERS.includes(provider)) throw new Error(studioNativeI18n.t('音乐来源无效'));
    if (provider === 'auto') {
      const configured = this.providers?.snapshot?.() || {};
      const sources = TRACK_PROVIDERS.filter(source => source === 'local' || configured[source]?.configured === true);
      const results = await Promise.allSettled(sources.map(async source => {
        try {
          const tracks = await this.search(cleaned, source, { signal });
          if (!signal?.aborted) onSource?.(source, tracks.length ? 'searched' : 'no_matches');
          return tracks;
        } catch (error) {
          if (!signal?.aborted) onSource?.(source, 'source_failed', 'SONG_SEARCH_FAILED');
          throw error;
        }
      }));
      if (signal?.aborted || this.disposed) throw new Error(studioNativeI18n.t('点歌已取消'));
      const tracks = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      if (!tracks.length && results.slice(1).length && results.slice(1).every(result => result.status === 'rejected')) {
        throw new Error(studioNativeI18n.t('在线音乐服务搜索失败'));
      }
      return tracks;
    }
    if (provider === 'local') {
      const words = cleaned.split(/\s+/u).map(matchText).filter(Boolean);
      return this.library.filter(track => words.every(word => matchText(`${track.title} ${track.artist}`).includes(word)))
        .slice(0, 50).map(publicTrack);
    }
    if (typeof this.providers?.search !== 'function') throw new Error(studioNativeI18n.t('在线音乐服务未连接'));
    const results = await this.external(controller => this.providers.search(provider, cleaned, { signal: controller.signal }), signal);
    if (!Array.isArray(results)) throw new Error(studioNativeI18n.t('音乐服务返回无效'));
    return results.slice(0, 50).flatMap(track => { try { return [normalizeTrack(track, provider)]; } catch { return []; } });
  }
  external(operation, signal) {
    const controller = new AbortController(); this.searches.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || this.disposed) controller.abort();
    let timer, onAbort;
    const cancelled = new Promise((resolve, reject) => {
      onAbort = () => reject(new Error(studioNativeI18n.t('点歌已取消')));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { reject(new Error(studioNativeI18n.t('音乐服务响应超时'))); controller.abort(); }, MAX_SEARCH_MS);
      timer.unref?.();
    });
    const task = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error(studioNativeI18n.t('点歌已取消'));
      return operation(controller);
    });
    return Promise.race([task, cancelled]).finally(() => {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', abort); this.searches.delete(controller);
    });
  }
  context(value = {}) {
    return { platform: PLATFORMS.includes(value.platform) ? value.platform : 'manual', user_id: clean(value.user_id),
      user_name: clean(value.user_name || (value.manual ? '主播' : '观众'), 64), room_id: clean(value.room_id), manual: value.manual === true };
  }
  prune() {
    const now = this.now();
    for (const [key, bucket] of this.credits) {
      bucket.grants = bucket.grants.filter(grant => grant.expiresAt > now && grant.count > 0);
      for (const [rule, partial] of bucket.partials) if (partial.expiresAt <= now) bucket.partials.delete(rule);
      if (!bucket.grants.length && !bucket.partials.size) this.credits.delete(key);
    }
    for (const [key, value] of this.recent) if (now - value.at >= Math.max(60_000, this.settings.cooldownSeconds * 1000)) this.recent.delete(key);
    for (const [id, at] of this.seen) if (now - at > 600_000) this.seen.delete(id);
  }
  takeCredit(key) {
    const grant = this.credits.get(key)?.grants.find(item => item.count > 0 && item.expiresAt > this.now());
    if (!grant) return null;
    grant.count--; return { key, expiresAt: grant.expiresAt, generation: this.creditGeneration };
  }
  refund(item) {
    if (item.ticket && item.ticket.generation === this.creditGeneration && item.ticket.expiresAt > this.now()) {
      let bucket = this.credits.get(item.ticket.key);
      if (!bucket && this.credits.size < MAX_IDENTITIES) { bucket = { grants: [], partials: new Map() }; this.credits.set(item.ticket.key, bucket); }
      if (bucket && bucket.grants.reduce((sum, grant) => sum + grant.count, 0) < MAX_CREDITS) bucket.grants.push({ count: 1, expiresAt: item.ticket.expiresAt });
    }
    item.ticket = null;
    if (item.cooldownKey && this.recent.get(item.cooldownKey)?.id === item.id) this.recent.delete(item.cooldownKey);
  }
  releaseTracks(item) {
    item.prepared?.abort.abort();
    try { this.providers?.releaseTracks?.(item.id); } catch { /* Cache cleanup must not interrupt queue cancellation. */ }
  }
  reject(reason) { return Promise.resolve({ accepted: false, reason: studioNativeI18n.t(reason) }); }
  request(query, value = {}) { return this.admit(query, value); }
  enqueueTrack(track, value = {}) {
    let trusted;
    try {
      if (track?.provider === 'local') trusted = this.library.find(item => item.id === track.id);
      else trusted = normalizeTrack(track, track?.provider);
      if (!trusted) throw new Error(studioNativeI18n.t('歌曲不存在'));
    } catch { return this.reject('歌曲信息无效'); }
    return this.admit(trusted.title, value, publicTrack(trusted));
  }
  admit(query, value, selectedTrack) {
    const context = this.context(value), config = this.settings.platforms[context.platform];
    const request = { id: randomUUID(), at: this.now(), trace: createSongTrace(this.now()) };
    const deny = reason => {
      if (!this.disposed) this.record({ ...request, query: clean(query, 200), context }, '未加入', studioNativeI18n.t(reason));
      return this.reject(reason);
    };
    if (this.disposed) return this.reject('点歌已停止');
    if (this.emergencyStopped) return deny('点歌已停止，请点击「继续播放」恢复接收点歌');
    if (!context.manual && (!this.settings.enabled || !config?.enabled)) return deny('点歌未启用');
    let cleaned, parsed;
    try { parsed = selectedTrack ? { query: text(query, 200, '歌曲搜索') } : parseSongQuery(query); cleaned = parsed.query; } catch (error) {
      return deny(error.code === 'SONG_QUERY_INVALID' ? '请按“歌名 + 歌手”填写点歌内容' : '歌曲名称须为 1～200 个字符');
    }
    this.prune();
    if (this.queue.filter(item => !item.recommendation).length + (this.current && !this.current.recommendation ? 1 : 0) >= this.settings.maxQueue) return deny('点歌队列已满');
    const key = identity(context), now = this.now(), prior = key && this.recent.get(key);
    if (!context.manual && !value.fixedGift && prior && now - prior.at < this.settings.cooldownSeconds * 1000) return deny('点歌冷却中');
    const ticket = !context.manual && !value.fixedGift && config?.giftRequired ? this.takeCredit(key) : null;
    if (!context.manual && !value.fixedGift && config?.giftRequired && !ticket) return deny(context.user_id ? '请先送出指定点歌礼物' : '平台未提供用户 ID，无法核验点歌资格');
    const item = { ...request, context, query: cleaned, provider: selectedTrack?.provider || this.settings.musicProvider,
      at: now, stage: '正在搜索', status: 'searching', track: null, ticket,
      cooldownKey: !context.manual && !value.fixedGift ? key : '', abort: new AbortController() };
    if (item.cooldownKey) {
      this.recent.set(item.cooldownKey, { at: now, id: item.id });
      while (this.recent.size > MAX_IDENTITIES) this.recent.delete(this.recent.keys().next().value);
    }
    const delivered = new Promise(resolve => { item.deliver = resolve; });
    this.mark(item, 'searching');
    this.queue.push(item); this.changed();
    Promise.resolve().then(async () => {
      const candidates = selectedTrack ? [selectedTrack] : selectMatchingTracks(parsed, await this.search(cleaned, item.provider, {
        signal: item.abort.signal, onSource: (provider, stage, code) => { this.mark(item, stage, provider, code); this.changed(); }
      }));
      if (!candidates.length) throw Object.assign(new Error(studioNativeI18n.t('未找到歌曲')), { code: 'SONG_NOT_FOUND' });
      if (item.abort.signal.aborted || this.disposed) return;
      this.mark(item, 'matched');
      const online = candidates.filter(track => track.provider !== 'local');
      if (online.length) this.providers?.retainTracks?.(item.id, online);
      item.candidates = candidates; item.candidate = candidates[0]; item.status = 'resolved'; this.drainAdmissions();
    }).catch(error => {
      if (item.abort.signal.aborted || this.disposed) return;
      this.mark(item, 'source_failed', undefined, ['SONG_NOT_FOUND', 'SONG_AMBIGUOUS'].includes(error.code) ? error.code : 'SONG_SEARCH_FAILED');
      item.failure = error.code === 'SONG_NOT_FOUND' ? '未找到歌名与歌手完全匹配的歌曲，请检查名称或歌手' :
        error.code === 'SONG_AMBIGUOUS' ? '找到多个同名版本，请使用“点歌+歌名+歌手”' : '搜索失败，请检查音乐服务或账号登录状态';
      item.status = 'resolved'; this.drainAdmissions();
    });
    return delivered;
  }
  drainAdmissions() {
    // Searches may finish in any order; decisions and playback retain event arrival order.
    for (const item of [...this.queue]) {
      if (item.status === 'ready') continue;
      if (item.status !== 'resolved') break;
      const duplicate = !item.failure && this.settings.duplicatePolicy &&
        [this.current, ...this.queue.filter(other => other !== item && other.status === 'ready')]
          .some(other => other?.track && (trackKey(other.track) === trackKey(item.candidate) || recordingKey(other.track) === recordingKey(item.candidate)));
      if (item.failure || duplicate) {
        const reason = item.failure || '这首歌已在队列或正在播放';
        this.queue.splice(this.queue.indexOf(item), 1); this.refund(item); this.releaseTracks(item); this.record(item, '未加入', reason);
        item.deliver({ accepted: false, reason: studioNativeI18n.t(reason) });
      } else {
        item.track = item.candidate; item.candidate = null; item.status = 'ready'; item.stage = '等待播放';
        this.mark(item, 'queued');
        item.deliver({ accepted: true, item: this.publicItem(item) });
      }
    }
    this.changed(); this.pump(); this.prepareNext();
  }
  async accept(event) {
    if (!event || this.disposed || event.preview || event.source === 'simulation' || !PLATFORMS.includes(event.platform)) return { accepted: false, reason: studioNativeI18n.t('忽略事件') };
    this.prune();
    if (event.event_id) {
      const id = JSON.stringify([event.platform, event.room_id, clean(event.event_id, 512)]);
      if (this.seen.has(id)) return { accepted: false, reason: studioNativeI18n.t('重复事件') };
      this.seen.set(id, this.now());
      while (this.seen.size > 20_000) this.seen.delete(this.seen.keys().next().value);
    }
    const config = this.settings.platforms[event.platform];
    if (event.event_type === 'comment') {
      if (event.content?.trim() === '撤回点歌' && this.settings.enabled && config.enabled && !this.emergencyStopped) return this.withdraw(event);
      const query = matchFormat(event.content, config.format);
      if (!query) return { accepted: false, reason: studioNativeI18n.t('未匹配点歌格式') };
      return this.request(query, event);
    }
    if (this.emergencyStopped || !this.settings.enabled || !config.enabled) return { accepted: false, reason: studioNativeI18n.t('忽略事件') };
    if (event.event_type !== 'gift') return { accepted: false, reason: studioNativeI18n.t('忽略事件') };
    if (event.count_mode && event.count_mode !== 'delta') return { accepted: false, reason: studioNativeI18n.t('礼物数量须为增量') };
    const count = event.gift_count;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) return { accepted: false, reason: studioNativeI18n.t('礼物数量无效') };
    // Prefer ID rules. A configured ID never falls back to a matching display name.
    const gift = config.gifts.find(rule => rule.giftId && rule.giftId === event.gift_id) ||
      config.gifts.find(rule => !rule.giftId && rule.giftName === event.gift_name);
    if (!gift) return { accepted: false, reason: studioNativeI18n.t('未匹配点歌礼物') };
    const context = this.context(event), key = identity(context);
    if (gift.mode === 'credit' && !key) return { accepted: false, reason: studioNativeI18n.t('平台未提供用户 ID，无法授予点歌资格') };
    let bucket = key && this.credits.get(key);
    if (key && !bucket) {
      if (this.credits.size >= MAX_IDENTITIES) return { accepted: false, reason: studioNativeI18n.t('点歌资格人数已满') };
      bucket = { grants: [], partials: new Map() }; this.credits.set(key, bucket);
    }
    const ruleKey = JSON.stringify([gift.giftId, gift.giftName, gift.mode, gift.minCount]);
    const previous = bucket?.partials.get(ruleKey)?.count || 0;
    const total = previous + count, units = Math.floor(total / gift.minCount);
    const expiresAt = this.now() + this.settings.creditExpiryMinutes * 60_000;
    if (bucket) bucket.partials.set(ruleKey, { count: total % gift.minCount, expiresAt });
    if (gift.mode === 'credit') {
      const owned = bucket.grants.reduce((sum, grant) => sum + grant.count, 0);
      const granted = Math.min(units, MAX_CREDITS - owned);
      if (granted) bucket.grants.push({ count: granted, expiresAt });
      this.record({ query: `${gift.giftName || gift.giftId} · ${context.user_name}`, context },
        granted ? '已获得点歌次数' : units ? '点歌次数已达上限' : '点歌礼物已累计',
        granted ? `${granted} 次，${this.settings.creditExpiryMinutes} 分钟内有效` : units ? `最多保留 ${MAX_CREDITS} 次` : `${total % gift.minCount} / ${gift.minCount} 个`);
      this.changed(); return { accepted: true, credits: granted };
    }
    const requests = [];
    for (let index = 0; index < Math.min(units, this.settings.maxQueue); index++) requests.push(this.request(gift.song, { ...event, fixedGift: true }));
    if (!requests.length) return { accepted: true, requests: 0 };
    const results = await Promise.all(requests);
    return { accepted: results.some(result => result.accepted), requests: results.filter(result => result.accepted).length,
      ...(!results.some(result => result.accepted) ? { reason: results[0].reason } : {}) };
  }
  withdraw(event) {
    const context = this.context(event), key = identity(context);
    const item = key && [...this.queue].reverse().find(row => !row.context.manual && identity(row.context) === key);
    if (!item) {
      const reason = key ? '没有可以撤回的待播歌曲；正在播放的歌曲请联系主播' : '平台未提供用户 ID，无法核验撤回资格';
      this.record({ context, query: '撤回点歌' }, '未撤回', reason);
      return { accepted: false, reason: studioNativeI18n.t(reason) };
    }
    this.remove(item.id);
    return { accepted: true, withdrawn: item.id };
  }
  async resolveMedia(track, signal) {
    if (track.provider === 'local') {
      const local = this.library.find(item => item.id === track.id);
      if (!local || !fs.existsSync(path.join(this.musicDirectory, local.file))) throw new Error(studioNativeI18n.t('歌曲文件已丢失'));
      return { file: path.join(this.musicDirectory, local.file) };
    }
    if (typeof this.providers?.resolve !== 'function') throw new Error(studioNativeI18n.t('在线音乐服务未连接'));
    const media = await this.external(controller => this.providers.resolve(publicTrack(track), { signal: controller.signal }), signal);
    if (!media || (typeof media.file !== 'string' && typeof media.url !== 'string')) throw new Error(studioNativeI18n.t('歌曲暂时无法播放'));
    if (media.url) {
      const url = new URL(media.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(studioNativeI18n.t('歌曲地址无效'));
      return { url: url.href, duration: media.duration };
    }
    return { file: media.file, duration: media.duration };
  }
  usablePreparation(item) {
    const prepared = item.prepared;
    return prepared?.media && !prepared.abort.signal.aborted && prepared.revision === (this.providers?.sourceRevision ?? 0) &&
      this.now() >= prepared.at && this.now() - prepared.at < 30_000 ? prepared : null;
  }
  prepareNext() {
    if (this.disposed || this.paused || !this.settings.enabled || !this.settings.autoPlay || !this.current?.playbackStarted) return;
    const item = this.queue[0];
    if (!item || item.status !== 'ready' || item.prepared) return;
    const prepared = { abort: new AbortController(), revision: this.providers?.sourceRevision ?? 0 };
    item.prepared = prepared;
    // Only the next song is checked, and only after current audio has started.
    // Media stays in memory for at most 30 seconds of reuse; it never enters snapshots.
    prepared.task = this.prepare(item, prepared);
    this.preparations.add(prepared.task);
    prepared.task.finally(() => this.preparations.delete(prepared.task));
  }
  async prepare(item, prepared) {
    item.stage = '正在预检下一首音源'; this.mark(item, 'preparing'); this.changed();
    for (const track of item.candidates || [item.track]) {
      if (prepared.abort.signal.aborted || this.disposed) return;
      if (prepared.revision !== (this.providers?.sourceRevision ?? 0)) { item.stage = '等待播放'; this.changed(); return; }
      try {
        const media = await this.resolveMedia(track, prepared.abort.signal);
        if (prepared.abort.signal.aborted || this.disposed) return;
        if (prepared.revision !== (this.providers?.sourceRevision ?? 0)) { item.stage = '等待播放'; this.changed(); return; }
        prepared.media = media; prepared.track = track; prepared.at = this.now();
        this.mark(item, 'prepared', track.provider);
        item.stage = '音源预检通过，等待播放'; this.changed(); return;
      } catch (error) {
        if (prepared.abort.signal.aborted || this.disposed) return;
        this.mark(item, 'source_failed', track.provider, ['MUSIC_TRIAL_ONLY', 'MUSIC_NO_SOURCE'].includes(error?.code) ? error.code : 'MUSIC_SOURCE_FAILED');
      }
    }
    item.stage = '音源预检未通过，播放时重试'; this.changed();
  }
  pump(force = false) {
    if (this.disposed || this.paused || this.current || (!force && (!this.settings.enabled || !this.settings.autoPlay))) return;
    const item = this.queue[0]; if (!item || item.status !== 'ready') return;
    this.queue.shift();
    const token = { ...item, abort: new AbortController(), stage: '正在获取音频', status: 'playing' };
    this.current = token; this.changed();
    const task = this.play(token);
    this.playbackTasks.add(task); task.finally(() => this.playbackTasks.delete(task));
  }
  async play(token) {
    try {
      if (token.prepared?.task) await this.external(() => token.prepared.task, token.abort.signal).catch(() => {});
      if (this.current !== token || this.disposed || token.abort.signal.aborted) return;
      const prepared = this.usablePreparation(token);
      const originals = token.candidates?.length ? token.candidates : [token.track];
      const candidates = prepared ? [prepared.track, ...originals.filter(track => trackKey(track) !== trackKey(prepared.track))] : originals;
      for (let index = 0; index < candidates.length; index++) {
        if (this.current !== token || this.disposed || token.abort.signal.aborted) return;
        token.audioId = index ? `${token.id}:${index}` : token.id;
        token.playbackStarted = false; token.audioRequested = false;
        this.mark(token, 'resolving', candidates[index].provider);
        token.track = candidates[index]; token.stage = index ? '正在切换同曲音源' : '正在获取音频'; this.changed();
        let attemptedPlayback = false;
        try {
          const media = prepared && trackKey(token.track) === trackKey(prepared.track) && this.usablePreparation(token)
            ? prepared.media : await this.resolveMedia(token.track, token.abort.signal);
          if (this.current !== token || this.disposed || token.abort.signal.aborted) return;
          this.mark(token, 'loading', token.track.provider);
          token.stage = this.paused ? '已暂停' : '正在加载音频'; this.changed();
          if (this.current !== token || this.disposed || token.abort.signal.aborted) return;
          const duration = Number.isFinite(media.duration) ? media.duration : token.track.duration;
          const timeoutMs = Number.isFinite(duration) && duration > 0 ? Math.min(3_600_000, Math.max(60_000, (duration + 60) * 1000)) : 1_800_000;
          let stopListener;
          const stopped = new Promise(resolve => {
            stopListener = () => resolve({ cancelled: true });
            token.abort.signal.addEventListener('abort', stopListener, { once: true });
          });
          let result;
          try {
            attemptedPlayback = true; token.playbackAttempted = true; token.audioRequested = true;
            const playing = Promise.resolve(this.backend.play({ id: token.audioId, ...media, duration, volume: this.settings.volume,
              device: this.settings.device, timeoutMs, paused: this.paused }));
            result = await Promise.race([playing, stopped]);
          } finally { token.abort.signal.removeEventListener('abort', stopListener); }
          if (this.current !== token || this.disposed || token.abort.signal.aborted) return;
          if (result?.error) throw audioError(result.code);
          this.record(token, result?.cancelled ? '已停止' : '已播放');
          return;
        } catch (error) {
          if (this.current !== token || this.disposed || token.abort.signal.aborted) return;
          this.mark(token, 'source_failed', token.track.provider, attemptedPlayback ? audioError(error?.code).code :
            ['MUSIC_TRIAL_ONLY', 'MUSIC_NO_SOURCE'].includes(error?.code) ? error.code : 'MUSIC_SOURCE_FAILED');
          if (attemptedPlayback) {
            // A failed backend task must release its audio before the next source is started.
            try { this.backend.stop(token.audioId); } catch { /* The failed task may already be gone. */ }
          }
          if (index === candidates.length - 1) {
            this.refund(token);
            const detail = attemptedPlayback ? audioError(error?.code).message : '请检查本地文件、账号权限或音乐服务';
            this.record(token, '播放失败', `歌曲所有匹配音源均无法播放，已继续下一首；${detail}`);
          }
        }
      }
    } finally {
      if (this.current === token) { this.current = null; this.releaseTracks(token); this.changed(); this.pump(); }
    }
  }
  playNext() { this.ensureOpen(); this.pump(true); return this.snapshot(); }
  stopCurrent(state = '已跳过') {
    const token = this.current; this.current = null;
    if (token) {
      token.abort.abort(); this.backend.stop(token.audioId || token.id);
      if (!token.playbackAttempted) this.refund(token);
      this.releaseTracks(token);
      this.record(token, state);
    }
    this.changed();
  }
  skip() { this.ensureOpen(); this.stopCurrent(); this.pump(); return this.snapshot(); }
  remove(id) {
    this.ensureOpen();
    const index = this.queue.findIndex(item => item.id === id);
    if (index < 0) throw new Error(studioNativeI18n.t('队列歌曲不存在'));
    const [item] = this.queue.splice(index, 1);
    item.abort.abort(); this.refund(item); this.releaseTracks(item);
    if (item.status !== 'ready') item.deliver({ accepted: false, reason: studioNativeI18n.t('点歌已取消') });
    this.record(item, '已取消');
    this.changed(); this.drainAdmissions(); return this.snapshot();
  }
  clearQueue() {
    this.ensureOpen();
    const items = this.queue; this.queue = [];
    for (const item of items) {
      item.abort.abort(); this.refund(item); this.releaseTracks(item);
      if (item.status !== 'ready') item.deliver({ accepted: false, reason: studioNativeI18n.t('点歌已取消') });
      this.record(item, '已取消');
    }
    this.changed(); return this.snapshot();
  }
  pause(value) {
    this.ensureOpen();
    if (typeof value !== 'boolean') throw new Error(studioNativeI18n.t('暂停状态无效'));
    this.paused = value;
    if (!value) this.emergencyStopped = false;
    if (this.current) {
      if (typeof this.backend.setPaused === 'function') {
        this.current.stage = value ? '已暂停' : this.current.playbackStarted ? '正在播放' : this.current.audioRequested ? '正在加载音频' : '正在获取音频';
        Promise.resolve(this.backend.setPaused(this.current.audioId || this.current.id, value)).catch(() => this.record(this.current || {}, '暂停失败', '音频后台暂时不可用'));
      } else if (value) {
        // A backend without pause support restarts the current song after resuming.
        const token = this.current; this.current = null; token.abort.abort(); this.backend.stop(token.audioId || token.id);
        token.abort = new AbortController(); token.status = 'ready'; token.stage = '等待播放'; this.queue.unshift(token);
      }
    }
    this.changed(); if (!value) { this.pump(); this.prepareNext(); } return this.snapshot();
  }
  emergency() {
    this.ensureOpen(); this.paused = true; this.emergencyStopped = true;
    this.clearQueue(); this.stopCurrent('已停止'); this.credits.clear(); this.creditGeneration++; this.recent.clear();
    this.changed(); return this.snapshot();
  }
  async dispose() {
    this.audioFiles.dispose();
    if (this.disposed) return;
    this.emergency(); this.disposed = true;
    this.cancelImport();
    this.backend.removeListener?.('change', this.backendChange);
    this.backend.removeListener?.('playback-started', this.backendStarted);
    this.backend.removeListener?.('unavailable', this.backendUnavailable);
    for (const controller of this.searches) controller.abort();
    await Promise.allSettled([...this.playbackTasks, ...this.preparations, this.importTask].filter(Boolean));
    this.removeAllListeners();
    // Backend ownership stays with the plugin, which also uses it for speech and sound effects.
  }
}

module.exports = { SongRequests, defaults, validateSettings, matchFormat, parseSongQuery, selectMatchingTracks, MUSIC_PROVIDERS };
