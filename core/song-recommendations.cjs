'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SongRequests } = require('./song-requests.cjs');
const { createSongTrace } = require('./song-diagnostics.cjs');
const { createSettingsStore } = require('./settings-store.cjs');

const SOURCES = ['qq', 'netease'];
const LABELS = { qq: 'QQ 音乐', netease: '网易云音乐' };
const RETRY_MS = 60_000;
const RECENT_MS = 2 * 60 * 60_000;
const recording = track => `${track.title}|${track.artist}`.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

// Recommendations use the same player and lifecycle as audience requests. They use the current
// playback slot, never the audience queue, so even an unresolved request has priority.
class RecommendationSongs extends SongRequests {
  constructor(options) {
    super(options);
    this.recommendationStore = createSettingsStore(path.join(this.directory, 'music-recommendations.json'), options.storageIo, {
      label: '推荐续播设置',
      validate: value => { if (typeof value.enabled !== 'boolean' || !SOURCES.includes(value.nextProvider)) throw Error('Invalid recommendations'); }
    });
    const saved = this.recommendationStore.read();
    this.recommendationSettings = saved.source === 'default' ? { enabled: false, nextProvider: 'qq' } : saved.value;
    this.recommendationWarning = saved.warning;
    this.recommendationStatus = '空闲时轮流播放 QQ 音乐和网易云音乐的个人推荐';
    this.recommendationCaches = new Map();
    this.recommendationRecent = new Map();
    this.recommendationCooldowns = new Map();
    this.recommendationFailures = new Map();
    this.recommendationStarted = false;
    this.recommendationGeneration = 0;
    this.recommendationRevision = this.providers?.sourceRevision || 0;
    this.onRecommendationSourceChange = () => {
      if (this.recommendationRevision !== (this.providers?.sourceRevision || 0)) {
        this.recommendationRevision = this.providers?.sourceRevision || 0;
        this.cancelRecommendationFetch();
        for (const provider of SOURCES) this.providers?.releaseTracks?.(`recommendations:${provider}`);
        this.recommendationCaches.clear(); this.recommendationCooldowns.clear();
        this.recommendationFailures.clear();
      }
      this.pump();
    };
    this.providers?.on?.('change', this.onRecommendationSourceChange);
    this.onRecommendationPlayback = id => {
      if (!this.current?.recommendation || this.current.audioId !== id || this.current.recommendationTurnAdvanced) return;
      this.current.recommendationTurnAdvanced = true;
      this.recommendationFailures.delete(this.current.track.provider);
      this.recommendationSettings.nextProvider = this.current.track.provider === 'qq' ? 'netease' : 'qq';
      try { this.recommendationStore.write(this.recommendationSettings); this.recommendationWarning = ''; }
      catch { this.recommendationWarning = '推荐轮换位置未能保存；当前播放不受影响'; }
      this.recommendationStatus = `正在播放${LABELS[this.current.track.provider]}推荐；本曲结束后优先播放点歌队列`;
      this.changed();
    };
    this.backend.on?.('playback-started', this.onRecommendationPlayback);
  }
  snapshot() {
    return { ...super.snapshot(), recommendations: {
      enabled: this.recommendationSettings?.enabled || false,
      nextProvider: this.recommendationSettings?.nextProvider || 'qq',
      loading: !!this.recommendationFetch,
      message: this.recommendationStatus || '', warning: this.recommendationWarning || '',
      waitingForRequests: this.current?.recommendation === true && this.queue.length > 0
    } };
  }
  publicItem(item) { return { ...super.publicItem(item), origin: item.recommendation ? 'recommendation' : 'request' }; }
  startRecommendations() { this.recommendationStarted = true; this.pump(); }
  configureRecommendations(enabled) {
    this.ensureOpen();
    if (typeof enabled !== 'boolean') throw Error('推荐续播开关无效');
    const next = { ...this.recommendationSettings, enabled };
    this.recommendationStore.write(next);
    this.recommendationSettings = next; this.recommendationWarning = '';
    this.cancelRecommendationFetch();
    this.recommendationStatus = enabled ? '推荐续播已开启；点歌队列优先' : '推荐续播已关闭；正在播放的歌曲会正常播完';
    this.changed(); this.pump(); return this.snapshot();
  }
  canRecommend() {
    return this.recommendationStarted && this.recommendationSettings?.enabled && !this.disposed &&
      !this.paused && !this.emergencyStopped && this.settings.enabled && this.settings.autoPlay && !this.current && !this.queue.length;
  }
  pump(force = false) {
    super.pump(force);
    if (!this.canRecommend() || this.recommendationFetch || this.recommendationTimer) return;
    // Defer until the request engine finishes synchronous admission/queue updates.
    this.recommendationTimer = setTimeout(() => {
      this.recommendationTimer = null;
      if (this.canRecommend()) this.fetchRecommendation();
    }, 0);
    this.recommendationTimer.unref?.();
  }
  cancelRecommendationFetch() {
    this.recommendationGeneration++;
    clearTimeout(this.recommendationTimer); this.recommendationTimer = null;
    this.recommendationFetch?.controller.abort();
  }
  async fetchRecommendation() {
    if (!this.canRecommend() || this.recommendationFetch) return;
    const operation = { controller: new AbortController(), generation: this.recommendationGeneration };
    this.recommendationFetch = operation;
    this.recommendationStatus = '正在获取个人推荐'; this.changed();
    const valid = () => !this.disposed && !operation.controller.signal.aborted && operation.generation === this.recommendationGeneration;
    let started = false;
    try {
      for (const [key, at] of this.recommendationRecent) if (this.now() - at >= RECENT_MS) this.recommendationRecent.delete(key);
      const first = this.recommendationSettings.nextProvider;
      for (const provider of [first, ...SOURCES.filter(source => source !== first)]) {
        if (!valid() || !this.canRecommend()) return;
        if (!this.providers?.snapshot?.()[provider]?.configured || (this.recommendationCooldowns.get(provider) || 0) > this.now()) continue;
        try {
          let tracks = this.recommendationCaches.get(provider) || [];
          if (!tracks.length) {
            tracks = await this.external(controller => this.providers.recommend(provider, { signal: controller.signal }), operation.controller.signal);
            if (!valid()) return;
            tracks = tracks.filter(track => !this.recommendationRecent.has(recording(track))).slice(0, 40);
            this.providers.retainTracks?.(`recommendations:${provider}`, tracks);
            this.recommendationCaches.set(provider, tracks);
          }
          while (tracks.length && this.recommendationRecent.has(recording(tracks[0]))) tracks.shift();
          if (!tracks.length) { this.recommendationCooldowns.set(provider, this.now() + RETRY_MS); continue; }
          // A comment may have arrived while the provider request was in flight.
          if (!valid() || !this.canRecommend()) return;
          const track = tracks.shift(), id = randomUUID();
          this.providers.retainTracks?.(id, [track]);
          const token = { id, at: this.now(), trace: createSongTrace(this.now()),
            context: { manual: true, platform: 'manual', user_id: '', user_name: `${LABELS[provider]}推荐`, room_id: '' },
            query: track.title, provider, track, candidates: [track], recommendation: true,
            abort: new AbortController(), status: 'playing', stage: '正在获取音频' };
          this.recommendationRecent.set(recording(track), this.now());
          while (this.recommendationRecent.size > 300) this.recommendationRecent.delete(this.recommendationRecent.keys().next().value);
          this.current = token; started = true; this.mark(token, 'queued'); this.changed();
          const task = this.play(token);
          this.playbackTasks.add(task); task.finally(() => this.playbackTasks.delete(task));
          return;
        } catch {
          if (!valid()) return;
          this.recommendationCooldowns.set(provider, this.now() + RETRY_MS);
          this.recommendationStatus = `${LABELS[provider]}推荐暂时不可用，正在尝试另一个平台`;
          this.changed();
        }
      }
      if (valid()) this.recommendationStatus = '暂时没有新的可播放推荐；请检查音乐账号，稍后会自动重试';
    } finally {
      if (this.recommendationFetch === operation) this.recommendationFetch = null;
      this.changed();
      if (!started && valid() && this.canRecommend()) {
        this.recommendationTimer = setTimeout(() => { this.recommendationTimer = null; this.pump(); }, RETRY_MS);
        this.recommendationTimer.unref?.();
      } else this.pump();
    }
  }
  record(item, state, detail = '') {
    // A minimal backend may acknowledge completion without emitting started.
    if (item?.recommendation && state === '已播放') this.onRecommendationPlayback?.(item.audioId);
    if (item?.recommendation && state === '播放失败') {
      const failures = (this.recommendationFailures?.get(item.track.provider) || 0) + 1;
      this.recommendationFailures?.set(item.track.provider, failures);
      if (failures >= 3) this.recommendationCooldowns?.set(item.track.provider, this.now() + RETRY_MS);
      this.recommendationStatus = `${LABELS[item.track.provider]}推荐歌曲无法完整播放，将尝试其他推荐`;
    }
    super.record(item, state, detail);
  }
  clearQueue() { const result = super.clearQueue(); this.pump(); return result; }
  pause(value) { if (value) this.cancelRecommendationFetch(); return super.pause(value); }
  emergency() { this.cancelRecommendationFetch(); return super.emergency(); }
  async dispose() {
    this.cancelRecommendationFetch();
    this.providers?.removeListener?.('change', this.onRecommendationSourceChange);
    this.backend.removeListener?.('playback-started', this.onRecommendationPlayback);
    for (const provider of SOURCES) this.providers?.releaseTracks?.(`recommendations:${provider}`);
    await super.dispose();
  }
}
module.exports = { RecommendationSongs };
