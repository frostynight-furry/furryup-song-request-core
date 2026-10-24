'use strict';
const studioNativeI18n = require("./messages.cjs");
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function createSettingsStore(filename, io = fs, { validate = () => {}, label = studioNativeI18n.t('工作台设置') } = {}) {
  const backup = `${filename}.bak`;
  const invalid = cause => Object.assign(new Error(studioNativeI18n.tr`${label}格式无效`, { cause }), { code: 'SETTINGS_FORMAT_INVALID' });
  const check = value => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings');
      validate(value);
    } catch (error) { throw invalid(error); }
    return value;
  };
  const parse = file => {
    // Filesystem failures must remain failures: a permission error is not an empty file.
    const text = io.readFileSync(file, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch (error) { throw invalid(error); }
    return check(value);
  };
  function atomic(file, text) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { io.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); io.renameSync(temporary, file); }
    finally { try { io.unlinkSync(temporary); } catch { /* Preserve the original write failure. */ } }
  }
  function read() {
    try { return { value: parse(filename), warning: '', source: 'primary' }; }
    catch (error) {
      if (!['ENOENT', 'SETTINGS_FORMAT_INVALID'].includes(error.code)) throw error;
      try { return { value: parse(backup), source: 'backup', warning: studioNativeI18n.tr`${label}未能完整读取，已恢复最近有效备份。原文件会保留用于排查。` }; }
      catch (backupError) {
        if (!['ENOENT', 'SETTINGS_FORMAT_INVALID'].includes(backupError.code)) throw backupError;
        const missing = error.code === 'ENOENT' && backupError.code === 'ENOENT';
        return { value: {}, source: 'default', warning: missing ? '' : studioNativeI18n.tr`${label}已损坏，当前使用默认配置；保存时会保留损坏原件。请检查设置后重新保存。` };
      }
    }
  }
  function write(value) {
    check(value);
    const text = JSON.stringify(value, null, 2);
    io.mkdirSync(path.dirname(filename), { recursive: true });
    let previous;
    try { previous = parse(filename); }
    catch (error) {
      if (!['ENOENT', 'SETTINGS_FORMAT_INVALID'].includes(error.code)) throw error;
      if (error.code !== 'ENOENT') io.copyFileSync(filename, `${filename}.${Date.now()}.${randomUUID()}.damaged`, fs.constants.COPYFILE_EXCL);
    }
    if (previous) atomic(backup, JSON.stringify(previous, null, 2));
    atomic(filename, text);
  }
  return { read, write };
}
module.exports = { createSettingsStore };
