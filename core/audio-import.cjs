'use strict';
const studioNativeI18n = require("./messages.cjs");
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function importAudio(owner, { files, prepare, directory, key, limit }) {
  if (owner.disposed) throw new Error(studioNativeI18n.t('工作台已停止'));
  if (owner.importTask) throw new Error(studioNativeI18n.t('已有导入正在进行，请等待完成或取消'));
  const prepared = prepare(files), abort = new AbortController(), created = [];
  owner.importAbort = abort;
  const progress = { phase: 'copying', completed: 0, count: prepared.length, bytes: 0,
    totalBytes: prepared.reduce((sum, item) => sum + item.size, 0), name: '' };
  owner.importState = progress;
  owner.changed();
  let lastNotify = 0;
  const task = (async () => {
    try {
      for (const item of prepared) {
        abort.signal.throwIfAborted();
        progress.name = item.title || item.name;
        const target = path.join(directory, item.file);
        let copied = 0;
        const output = fs.createWriteStream(target, { flags: 'wx' });
        output.once('open', () => created.push(target));
        const meter = new Transform({ transform(chunk, encoding, callback) {
          copied += chunk.length; progress.bytes += chunk.length;
          if (copied > item.size) { callback(new Error(studioNativeI18n.t('导入时文件发生变化，请重新选择'))); return; }
          if (Date.now() - lastNotify >= 200) { lastNotify = Date.now(); owner.changed(); }
          callback(null, chunk);
        } });
        await pipeline(fs.createReadStream(item.source), meter, output, { signal: abort.signal });
        if (copied !== item.size) throw new Error(studioNativeI18n.t('导入时文件发生变化，请重新选择'));
        progress.completed++; owner.changed();
      }
      abort.signal.throwIfAborted();
      if (owner.disposed) throw new Error(studioNativeI18n.t('工作台已停止'));
      if (owner[key].length + prepared.length > limit) throw new Error(studioNativeI18n.t('素材库已满，请移除部分素材后重试'));
      // Read the latest library only at commit, preserving edits made during copying.
      const previous = owner[key];
      owner[key] = [...previous, ...prepared.map(({ source, size, ...item }) => item)];
      try { owner.persist(); } catch (error) { owner[key] = previous; throw error; }
      owner.audioFiles?.add(prepared.map(item => item.file));
      progress.phase = 'complete';
      return owner.snapshot();
    } catch (error) {
      await Promise.allSettled(created.map(file => fs.promises.rm(file, { force: true })));
      progress.phase = abort.signal.aborted ? 'cancelled' : 'failed';
      if (abort.signal.aborted) return owner.snapshot();
      progress.error = error.message;
      throw error;
    } finally { owner.importTask = null; owner.importAbort = null; owner.changed(); }
  })();
  owner.importTask = task;
  return task;
}
function cancelAudioImport(owner) { owner.importAbort?.abort(); }
function existingAudioFiles(directory) {
  // One fresh directory read per snapshot avoids a filesystem call for every track.
  try { return new Set(fs.readdirSync(directory)); } catch { return new Set(); }
}
module.exports = { importAudio, cancelAudioImport, existingAudioFiles };
