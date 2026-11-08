'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLrc, stanza, projectSongOutput } = require('../core/index.cjs');

test('parseLrc and stanza parse offsets, multi-timestamp lines, and 4-line lyric windows', () => {
  const raw = '[offset:500]\n[00:01.00]第一句歌词\n[00:03.50][00:08.00]副歌重复句\n[00:05.00]\n[00:06.20]间奏后下一句';
  const cues = parseLrc(raw);
  assert.equal(cues.length, 5);
  assert.equal(cues[0][0], 500);
  assert.equal(cues[0][1], '第一句歌词');

  const intro = stanza(cues, 0.2);
  assert.equal(intro.interval, 'intro');
  assert.equal(intro.lines[1], '');
  assert.equal(intro.lines[2], '第一句歌词');

  const active = stanza(cues, 3.2);
  assert.equal(active.interval, null);
  assert.equal(active.lines[0], '第一句歌词');
  assert.equal(active.lines[1], '副歌重复句');
  assert.equal(active.lines[2], '间奏后下一句');

  const inst = stanza(cues, 4.8);
  assert.equal(inst.interval, 'instrumental');
});

test('projectSongOutput sanitizes current and queued songs for OBS overlay', () => {
  const state = projectSongOutput({
    settings: { enabled: true, platforms: { bilibili: { enabled: true, format: '点歌 {song}' } } },
    current: { query: '夜霜之歌', user_name: '阿白', stage: 'playing', track: { title: '夜霜之歌', artist: 'FrostyNight' } },
    queue: [{ query: '月光', user_name: '小狼', stage: 'queued', track: { title: '月光', artist: '测试歌手' } }]
  });
  assert.equal(state.accepting, true);
  assert.equal(state.commandHint, '点歌+歌名+歌手');
  assert.equal(state.current.title, '夜霜之歌');
  assert.equal(state.current.artist, 'FrostyNight');
  assert.equal(state.queue.length, 1);
  assert.equal(state.queueCount, 1);
});
