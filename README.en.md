# FurryUP Song Request Core

[中文](README.md) · MIT · **0.2.0 preview**

Initiated and maintained by [FrostyNight (夜霜)](https://github.com/frostynight-furry), this reusable component originated in [FurryUP Studio](https://frostynight.top/furryup).

**For streamers seeking the complete product:** [FurryUP Studio website](https://frostynight.top/furryup) · [Download the installer](https://github.com/frostynight-furry/furryup-studio-releases)

**For developers integrating this component:** [Quick start](#developer-quick-start) · [Adapter contracts](docs/ADAPTERS.md)

A dependency-free Node.js song request engine extracted from FurryUP Studio. It provides command parsing, guarded title/artist matching, sequential admission, queue controls, viewer withdrawal, optional gift credits, cross-provider fallback, next-track preparation and bounded diagnostics.

The host injects providers and a player, and supplies normalized events. Platform/provider identifiers are supported routing labels, not included integrations. No live-chat collector, music API client, account login, cookies, real music or Electron player is shipped. FUS has completed one real-account recommendation/request rotation with actual audio ending, muted at 8x playback speed. Live broadcasts, all account/song entitlements and OBS capture still require validation. See [0.2.0 changes and verification scope](docs/CHANGES-0.2.0.md).

## Developer quick start

Requires Node.js 22.12 or newer. After downloading this repository, run the following commands without installing dependencies:

```sh
node scripts/verify.cjs
node examples/replay.cjs
```

The replay processes `点歌+示例旋律+示例乐队`, matches `示例旋律（Live）`, and prints the request history. It uses synthetic metadata and a simulated player, performs no network requests, and plays no audio. `private: true` prevents accidental npm publication; it does not restrict the MIT license or use of the source through GitHub.

## Integration

```js
const { SongRequests, defaults } = require('./core/index.cjs');

// The host implements backend and providers; see docs/ADAPTERS.md.
const engine = new SongRequests({ directory: './song-data', backend, providers });
engine.configure({ ...defaults(), enabled: true, musicProvider: 'auto' });
engine.on('change', () => render(engine.snapshot()));

await engine.accept({
  platform: 'bilibili', room_id: 'demo-room', user_id: 'demo-viewer',
  user_name: '示例观众', event_id: 'unique-event-id',
  event_type: 'comment', content: '点歌+示例旋律+示例乐队'
});
// When the host exits: await engine.dispose();
```

Song requests are disabled by default and must be enabled explicitly. The engine accepts `点歌 song artist` and `点歌+song+artist`; a custom format must contain exactly one `{song}` placeholder. Matching supports official aliases and omission of a single Live suffix while still checking the artist and rejecting ambiguous matches, wrong versions, and wrong artists.

## Personal recommendation rotation

Implement `providers.recommend(provider, { signal })` to return authorized personal recommendation metadata for `qq` and `netease`. Once the player is ready, call `engine.startRecommendations()` and `engine.configureRecommendations(true)`; song settings must also enable requests and automatic playback. This optional feature defaults to off.

Idle playback alternates one recommendation per provider. An incoming request waits for the current recommendation to finish; audience requests then drain in order before recommendations resume at the next source. Recommendations do not consume audience capacity. Pause, emergency stop, cancellation, retry cooldowns and recent-track deduplication apply. The enabled flag and next source persist separately in `music-recommendations.json`.

Space-separated requests now prefer an entire artist match over a matching duet member. Manual search still returns all versions, and unresolved ambiguity/version checks remain. Read the [recommendation adapter contract](docs/ADAPTERS.md#personal-recommendations) for authentication, caching and lifecycle responsibilities.

## Component scope

- Four normalized platform identifiers: `bilibili`, `douyin`, `kuaishou`, and `wechat`. These are event fields, not bundled platform collectors.
- Source identifiers: `local`, `netease`, `qq`, and `qishui`. `auto` searches sources marked as configured by the host. These names do not imply that the corresponding service is integrated.
- Sequential admission, duplicate-track checks, per-viewer cooldowns, gift credits scoped by platform/room/viewer, and withdrawal of a viewer's latest pending request.
- Pause, skip, clear, emergency stop, provider fallback, and continuation to the next track. Next-track preparation starts only after playback is confirmed; cancellation and late results cannot start an obsolete track.
- Local file import, persistent settings and library, preservation of damaged configuration, and backup recovery. **The pending queue, history, cooldowns, and gift credits do not survive a process restart.**
- Bounded stage records and fixed error codes. Management snapshots contain viewer identifiers and request content; the display layer must select public fields before sending data to OBS.

See the [adapter contracts](docs/ADAPTERS.md). Tests use synthetic events and players; hosts must validate real audio, disconnection, cancellation, permissions, and long-running use. This source release does not update FurryUP Studio installers or plugin channels.

## About FrostyNight and FurryUP Studio

FrostyNight (夜霜) initiated and maintains this repository and also develops FurryUP Studio for streamers. FurryUP Studio brings the live workbench, assistant, desktop companion, and screen mirroring workflows into a unified desktop interface, with installers and application/plugin update entry points. Visit the [website](https://frostynight.top/furryup) for the product overview and the [download repository](https://github.com/frostynight-furry/furryup-studio-releases) for available releases and release notes.

This repository is an independent song request engine for developers to integrate, not a complete song request product ready for use. The host supplies real music sources, account services, playback, and live events. Publishing this component's source does not mean that the public FurryUP Studio release includes the same version or its new features.

## Optional acknowledgement

If this component helps your project, you are welcome to mention FurryUP Song Request Core in your README, documentation, or About page, with links to the project, its maintainer, and FurryUP Studio. You can copy either example:

```markdown
This project uses [FurryUP Song Request Core](https://github.com/frostynight-furry/furryup-song-request-core), initiated and maintained by [FrostyNight (夜霜)](https://github.com/frostynight-furry). Learn about the product it originated from: [FurryUP Studio](https://frostynight.top/furryup).
```

```markdown
本项目使用 [FurryUP Song Request Core](https://github.com/frostynight-furry/furryup-song-request-core)，由[夜霜（FrostyNight）](https://github.com/frostynight-furry)发起并维护。了解其来源产品：[FurryUP Studio](https://frostynight.top/furryup)。
```

These acknowledgements and links are entirely optional and add no conditions to the [MIT license](LICENSE). The MIT requirement to retain its copyright and permission notices in copies or substantial portions of the software still applies. Using this component or adding an acknowledgement does not imply official endorsement of your project by FrostyNight or FurryUP Studio.
