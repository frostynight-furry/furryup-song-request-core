'use strict';
const clean = (value, length = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length) : '';
function projectSongOutput(songs) {
  const item = value => value ? { title: clean(value.track?.title || value.query), artist: clean(value.track?.artist),
    requester: clean(value.user_name || value.context?.user_name, 64), stage: clean(value.stage, 80) } : null;
  const queue = Array.isArray(songs?.queue) ? songs.queue : [];
  const rules = Object.values(songs?.settings?.platforms || {}).filter(rule => rule.enabled);
  const accepting = Boolean(songs?.settings?.enabled && !songs?.emergencyStopped && rules.length);
  return { available: Boolean(songs && !songs.disposed), paused: songs?.paused === true, stopped: songs?.emergencyStopped === true,
    accepting, commandHint: !accepting ? '暂不接收新点歌' : rules.every(rule => rule.format === '点歌 {song}') ? '点歌+歌名+歌手' : '请按主播设置的弹幕格式点歌',
    current: item(songs?.current), queue: queue.slice(0, 8).map(item).filter(Boolean), queueCount: Math.min(queue.length, 200) };
}
module.exports = { projectSongOutput };
