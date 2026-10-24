# FurryUP Song Request Core

[中文](README.md) · MIT · **0.1.0 preview**

A dependency-free Node.js song request engine extracted from FurryUP Studio. It provides command parsing, guarded title/artist matching, sequential admission, queue controls, viewer withdrawal, optional gift credits, cross-provider fallback, next-track preparation and bounded diagnostics.

Requires Node.js 22.12+. Run `node scripts/verify.cjs`, then `node examples/replay.cjs`. No installation step is needed. The replay uses synthetic metadata and a simulated player; it performs no network requests and plays no audio.

The host injects providers and a player, and supplies normalized events. Platform/provider identifiers are supported routing labels, not included integrations. No live-chat collector, music API client, account login, cookies, real music or Electron player is shipped. Live broadcasts, full-track playback, account entitlements and OBS audio capture have not been validated for this release. Do not treat preview test results as production readiness.

See [adapter contracts](docs/ADAPTERS.md). Settings and the imported local library persist; queue/history/credits are process-local. Management snapshots contain request and viewer metadata; filter them before public display. `private: true` prevents accidental npm publication; the source is MIT-licensed and available through GitHub.
