# Changelog

## 0.1.0a49 — 2026-11-15

- Add an explicit isolated Python archive cache option for managed runtime preparation and an offline-only preparation mode.
- Missing or unusable offline cache fails closed with a stable diagnostic; the install wrapper does not silently retry online.
- Installer protocol behavior changed; snapshot schema remains v2 and the product contract remains revision 30.

## 0.1.0a48 — 2026-11-13

- Add identity-bound batch restore for the allowlisted `.env` and `.env.local` pair, including per-target durable progress, new-process continuation, and rollback resumption after process termination.
- Keep batch publication per-file rather than promising atomic visibility; ambiguous/external changes remain preserved and are rejected.
- Contract revision 30; snapshot schema remains v2.

## 0.1.0a47 — 2026-11-13

- Preflight every derived Windows state-location publication path before creating the control parent, operation lock, stage, or selected root; return the existing `EWINDOWS_PATH_LIMIT` refusal instead of a filesystem exception.
- Apply the same path-budget check before resuming a pending location transaction. Active locations remain read-only verifications.
- Contract revision 29; snapshot schema remains v2.

## 0.1.0a46 — 2026-11-13

- Add explicit same-volume private state-root selection for new projects, with a single resolver, fail-closed legacy behavior, and process-crash resumable registration.
- Require SQLite 3.51.3 or newer for online backup/database restore and report unsupported engines through doctor.
- Contract revision 28; snapshot schema remains v2.

## 0.1.0a45 — 2026-11-12

- Redact untrusted artifact identifiers from integrity failure diagnostics.

## 0.1.0a44 — 2026-11-12

- Move snapshot generation and pointer publication into foundation, preserving no-replace and identity checks.

## 0.1.0a43 — 2026-11-12

- Move resolver owner binding and claim file identity-safe I/O to foundation; preserve recovery claim transition rules.

## 0.1.0a42 — 2026-11-12

- Complete the shared snapshot and SQLite capability descriptions and use the snapshot description in task diagnosis.

## 0.1.0a41 — 2026-11-12

- Bind internal capability and safety-point reference contracts to their actual consumers; add actionable cross-volume diagnostics while retaining the existing error code and refusal.

## 0.1.0a39 — 2026-11-09

- Publish new Windows state roots from a unique same-parent container only after the legacy marker and an initialization identity proof are complete and flushed.
- Bind the initialization proof to project/layout, initialization ID, directory identity, marker identity, and marker digest; verify the published root and refuse unknown markerless roots.
- Preserve the legacy marker payload and add deterministic process-exit, concurrent initializer, raced target, and identity replacement regressions.
- Contract revision 27; snapshot schema remains v2. This candidate remains unpublished and is not power-loss tested.

## 0.1.0a38 — 2026-11-08

- Repair config restore recovery from `prepared` when the target was absent.
- Restrict rollback of unverified publication; require `continue` before rollback.
- Validate operation journal status/phase combinations and immutable proof evolution.
- Preserve interrupted resolver claims through validated successor claims.
- Strengthen SQLite operation routing and cancellation evidence.
- Isolate `demo` project and state within one owned temporary container.
- Make test fixtures side-effect free at import time.
- Add versioned general `doctor --json` and strict collector protocol parsing.
- Add dashboard terminal-phase mapping and atomic archive manifest generation.

This remains an unpublished, Windows-only candidate. POSIX business writes are not verified; no release readiness is claimed.
- Contract revision: 26. Snapshot schema remains v2; general doctor JSON and process-vs-result handling are documented in `CONTRACTS.md`.
