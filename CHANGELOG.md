# Changelog

## 0.2.0 — 2026-10-31 — Preview source

- Add opt-in QQ / NetEase recommendation rotation through an injected `providers.recommend` method. Finish the current recommendation, drain audience requests in order, then resume the next source.
- Persist the recommendation switch and next source separately from existing song settings. Respect pause, emergency stop, cancellation, source changes, bounded retry and recent-track deduplication.
- Prefer a complete artist match over a duet in space-separated requests; retain manual search choices and ambiguity/version protection.
- Recommendations do not consume audience capacity, including a queue limit of one. A completion-only backend can still advance rotation.
- Document host integration, independent source provenance and the limits of synthetic and real-account validation. No music API dependency, credentials, desktop application or installer is added.

## 0.1.0 — 2026-10-24 — Preview

Initial standalone extraction: parsing, guarded matching, serial queue, source fallback, preparation, cancellation, viewer credits, local library persistence and bounded diagnostics. Includes injected provider/player contracts, synthetic replay, regression tests and source/archive audits. No music accounts, live collectors or desktop player are included. Real-broadcast and full-song acceptance remain pending.
