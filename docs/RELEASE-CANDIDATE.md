# Release candidate gate — 1.4.0-rc.8

This is a private local repository-preparation candidate, not a release. Package/tool version: `1.4.0-rc.8`; contract revision 20; snapshot schema v2. The package version was advanced for restore transaction, comparison, hook, lock, and installed-package verification changes.

| Gate | Status for this repository import |
|---|---|
| Source tree and history | New source-only import history; no prior history is represented as if it belonged to the candidate |
| Package/runtime version check | Passed locally; clean-checkout repetition remains part of final handoff |
| CI version | Updated from stale rc.4 and action references pinned to reviewed release commits; hosted workflow not run |
| Source tests on this import | Passed: 322 total, 321 pass, 0 fail, 1 explicit Windows symlink-capability skip; 0 cancelled/todo |
| Real tarball install and installed CLI snapshot/restore/rollback | Passed via `npm run test:install` on an offline fresh prefix |
| Strict real SQLite tests on this import | Passed 17/17 with `REQUIRE_SQLITE_TESTS=1`; installed SQLite seed restore and rollback also passed |
| npm pack contents and tarball hash | Passed allowlist check (18 files); retained tarball path and SHA are in local evidence manifest |
| Installed package CLI, restore and rollback | Passed via installed CLI; `sourceFallback=false`; file and SQLite exact rollback verified |
| Windows symlink capability skip from prior candidate | Explicitly unverified; not silently converted to a pass |
| Hosted Actions, Node/platform matrix | Not run before initial upload |
| Non-author user trial and application health | Not verified |
| Push, visibility change, Release or npm publish | Not performed; not authorized |

Do not use the rc.5 tarball or historical logs to satisfy this candidate's gates. The accompanying local delivery bundle contains the handoff evidence under `report/`; those machine-specific logs are intentionally not uploaded. This document does not claim hosted or cross-platform validation. The candidate remains local-only until the separate upload authorization step is complete.
