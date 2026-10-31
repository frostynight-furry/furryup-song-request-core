# Adapter contracts

The main CommonJS export provides `SongRequests`, `defaults`, `validateSettings`, `matchFormat`, `parseSongQuery`, `selectMatchingTracks` and `MUSIC_PROVIDERS`. Status messages are currently Chinese. The engine uses only Node built-ins and local helper modules.

## Providers

Pass an object with these methods:

```js
const providers = {
  sourceRevision: 0,
  snapshot() { return { netease: { configured: true } }; },
  async search(provider, query, { signal }) {
    return [{ id: 'fixture', title: '示例旋律', artist: '示例乐队', duration: 180 }];
  },
  async resolve(track, { signal }) {
    return { url: 'https://media.example.invalid/audio.wav', duration: 180 };
  }
};
```

`duration` is seconds. Search results may contain `aliases: string[]`. IDs must not encode URLs, paths, query strings or credentials. `search` returns metadata only. `resolve` returns `{url, duration?}` or `{file, duration?}`; the injected player consumes that media. Increase `sourceRevision` when provider configuration changes so prepared media is not reused. Honor `AbortSignal` for cancellation. Optional `retainTracks(requestId, tracks)` / `releaseTracks(requestId)` hooks pin metadata across provider cache eviction; see engine regression tests for their lifecycle.

Provider IDs in this first extraction are fixed: `local`, `netease`, `qq`, `qishui`; `auto` consults `snapshot()`. No API implementation is included. The host owns authorization, credentials, permitted media locations and actual access. Do not accept an untrusted remote party's provider implementation or file paths.

## Personal recommendations

Version 0.2.0 adds optional `providers.recommend(provider, { signal })` for `qq` and `netease`. Return normalized tracks `{ provider, id, title, artist, duration? }`, with duration in seconds and the provider matching the requested source. As with search, register IDs in the provider's trusted cache before returning; the engine later uses `resolve(track)` and optional `retainTracks/releaseTracks` hooks. This method must use the logged-in account's personal recommendations. Authentication and authorized retrieval remain host responsibilities; this package contains no music API client.

FUS currently requests daily recommendations first, then personal radio / radar recommendations through authenticated provider adapters. Other hosts may supply their own authorized feed. Do not return account objects, cookies or stream URLs in track metadata. Reject unavailable or unauthenticated feeds instead of silently substituting a public chart. Respect cancellation.

The exported `SongRequests` includes the scheduler. After the backend is ready call `engine.startRecommendations()`, then enable with `engine.configureRecommendations(true)`. Song settings must have `enabled` and `autoPlay` set to true. The feature is off by default, including when upgrading an existing data directory. Disabling it lets current playback finish.

The initial preferred source is QQ, alternating to NetEase after playback starts (or ends for a completion-only player). Requests arriving during a recommendation wait for that song to end. Requests arriving during a slow feed fetch have priority over fetched recommendations. When requests finish, rotation resumes at the saved next source. Recommendations do not use audience capacity or gift credit.

Only `enabled` and `nextProvider` persist in `music-recommendations.json`, using atomic writes and backup recovery. `song-requests.json` is unchanged by the recommendation switch. The recommendation cache, recent-track deduplication and error cooldowns are process-local. Pending requests and history still do not persist across restarts.

`snapshot().recommendations` provides `enabled`, `nextProvider`, `loading`, `message`, `warning` and `waitingForRequests`. Current and queued public items have `origin: 'request' | 'recommendation'`. Pause, resume, skip, clear and emergency controls apply to the shared engine. A backend without `setPaused` restarts its interrupted song on resume, as in 0.1.0.

On provider/account changes, increment `sourceRevision` and emit `change` to invalidate cached recommendations and pending fetches. The scheduler tries another configured provider when a feed is unavailable, avoids rapid retries (60-second cooldown), and filters recently attempted title/artist pairs for two hours. Hosts remain responsible for detecting incomplete audio and reporting playback failure.

## Player

`backend.play({ id, file?, url?, duration?, volume, device, timeoutMs, paused })` returns a promise resolving when playback ends. Resolve `{}` for completion, `{cancelled:true}` for cancellation, or `{error:true, code:'AUDIO_DECODE_FAILED'}` for a known failure. The engine maps unknown error codes to a fixed public error. The backend must enforce the supplied timeout and actual media/decoder checks; the engine cannot infer full-track playback from a false completion acknowledgement.

`backend.stop(id)` must be synchronous/nonthrowing and stop that playback attempt. A backend can be an `EventEmitter`: emit `playback-started` with the exact ID only after sound begins, `change` when devices/status change, and `unavailable` when playback is no longer usable. Fallback attempts have distinct IDs. Late signals are ignored.

Implement `setVolume(id, value)` for volume changes during playback. Optional `setPaused(id, boolean)` preserves the current media; if absent, pausing stops and requeues the track to restart later. Set `devices` to an array for the management snapshot. Backend ownership remains with the host: `engine.dispose()` removes listeners and cancels owned work without disposing a shared backend.

## Requests and lifecycle

- `accept(event)` handles normalized comments and gift deltas; `event_id` provides deduplication. The same user ID in different rooms/platforms has separate credits and withdrawal ownership.
- `request(query, context)` / `enqueueTrack(track, context)` submit host requests. `manual: true` is a trusted host capability and bypasses viewer restrictions; never expose it as an unauthenticated viewer option.
- `snapshot()` returns management state; `configure(settings)` validates and persists settings. Copy `defaults()` and change required fields.
- `playNext()`, `pause(boolean)`, `skip()`, `remove(id)`, `clearQueue()`, `emergency()` control the queue.
- `importFilesAsync(paths)` and `cancelImport()` manage authorized local audio imports; `removeTrack(id)` removes a library track. These are host-only operations.
- Await `dispose()` on shutdown. Keep adapter operations cancellable and player controls nonthrowing.

The `change` event carries no snapshot argument; call `snapshot()`. Persisted files contain settings and local-library metadata. Queue/history/credits are intentionally process-local in 0.1.0. Request history may contain viewers' names and text: keep it local or filter explicitly for a public view.
