# Changelog

## 0.3.0 (2026-11-08)

- 新增 `core/song-lyrics.cjs`：支持 LRC 歌词解析（`parseLrc`，支持 `[offset]` 全局偏移与同行多时间标签）、四行歌词窗口二分检索与前奏/间奏/尾奏区间识别（`stanza`）、以及同名 `.lrc` 旁路字幕文件多编码读取（`sidecar` / `readSidecar`，自动识别 UTF-8、UTF-16LE/BE 与 GB18030）。
- 新增 `core/song-output.cjs`：提供 `projectSongOutput` 纯函数，用于向 OBS 浏览器源安全投影当前播放曲目、待播队列与点歌指令提示。
- 新增 `test/lyrics.test.cjs` 单元测试。

## 0.2.0 — 2026-10-31 — Preview source

- Add opt-in QQ / NetEase recommendation rotation through an injected `providers.recommend` method. Finish the current recommendation, drain audience requests in order, then resume the next source.
- Persist the recommendation switch and next source separately from existing song settings. Respect pause, emergency stop, cancellation, source changes, bounded retry and recent-track deduplication.
- Prefer a complete artist match over a duet in space-separated requests; retain manual search choices and ambiguity/version protection.
- Recommendations do not consume audience capacity, including a queue limit of one. A completion-only backend can still advance rotation.
- Document host integration, independent source provenance and the limits of synthetic and real-account validation. No music API dependency, credentials, desktop application or installer is added.

## 0.1.0 — 2026-10-24 — Preview

Initial standalone extraction: parsing, guarded matching, serial queue, source fallback, preparation, cancellation, viewer credits, local library persistence and bounded diagnostics. Includes injected provider/player contracts, synthetic replay, regression tests and source/archive audits. No music accounts, live collectors or desktop player are included. Real-broadcast and full-song acceptance remain pending.
