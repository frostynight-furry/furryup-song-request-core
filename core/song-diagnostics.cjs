'use strict';
const { ERRORS } = require('./audio-diagnostics.cjs');
const STAGES = new Set(['received', 'searching', 'searched', 'no_matches', 'matched', 'queued', 'preparing', 'prepared', 'resolving', 'loading', 'playing', 'source_failed', 'rejected', 'played', 'stopped', 'cancelled']);
const SOURCES = new Set(['local', 'netease', 'qq', 'qishui']);
const CODES = new Set([...Object.keys(ERRORS), 'MUSIC_TRIAL_ONLY', 'MUSIC_NO_SOURCE', 'MUSIC_SOURCE_FAILED', 'SONG_NOT_FOUND', 'SONG_AMBIGUOUS', 'SONG_SEARCH_FAILED']);
function createSongTrace(now) { return { startedAt: now, steps: [{ stage: 'received', elapsedMs: 0 }] }; }
function markSongTrace(item, stage, now, provider, code) {
  if (!item?.trace || !STAGES.has(stage)) return;
  const steps = item.trace.steps;
  const step = { stage, elapsedMs: Math.max(steps.at(-1)?.elapsedMs || 0, Math.round(now - item.trace.startedAt), 0) };
  if (SOURCES.has(provider)) step.provider = provider;
  if (CODES.has(code)) step.code = code;
  steps.push(step);
  // Keep receipt plus the latest transitions; no URLs, raw exceptions or cookies.
  if (steps.length > 48) steps.splice(1, steps.length - 48);
}
function songTraceSnapshot(item) {
  return item.trace ? { requestId: item.id, elapsedMs: item.trace.steps.at(-1)?.elapsedMs || 0,
    steps: item.trace.steps.map(step => ({ ...step })) } : undefined;
}
module.exports = { createSongTrace, markSongTrace, songTraceSnapshot };
