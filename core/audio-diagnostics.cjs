'use strict';
// Public playback error vocabulary; raw adapter errors never enter request traces.
const ERRORS = Object.freeze({
  AUDIO_DECODE_FAILED: ['decode', '无法解码音频，请使用有效的 WAV、MP3、OGG 或 M4A 文件'],
  AUDIO_SOURCE_FAILED: ['decode', '音频来源不可用或格式不受支持，请检查文件或重新获取音源'],
  AUDIO_NETWORK_FAILED: ['decode', '音频加载时网络中断，请检查网络后重试'],
  AUDIO_DECODE_TIMEOUT: ['decode', '音频加载或解码超时，请检查音源后重试'],
  AUDIO_DEVICE_FAILED: ['playback', '无法使用所选输出设备，请检查设备连接后重试'],
  AUDIO_PLAYBACK_FAILED: ['playback', '音频播放失败，请检查输出设备是否仍可用'],
  AUDIO_PLAYBACK_TIMEOUT: ['playback', '音频播放超时，已停止本条音频'],
  AUDIO_INCOMPLETE_SOURCE: ['decode', '音源时长不足，请检查会员登录或完整歌曲播放权限'],
  AUDIO_BACKEND_UNAVAILABLE: ['playback', '音频后台不可用，请先恢复音频后台'],
});
function audioError(code, diagnostics) {
  const selected = Object.hasOwn(ERRORS, code) ? code : 'AUDIO_PLAYBACK_FAILED';
  const error = new Error(ERRORS[selected][1]);
  error.code = selected; error.stage = ERRORS[selected][0];
  if (diagnostics) error.diagnostics = diagnostics;
  return error;
}
module.exports = { audioError, ERRORS };
