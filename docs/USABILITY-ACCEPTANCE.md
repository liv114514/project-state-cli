# Usability fixes acceptance — 1.4.0-rc.10

This is a local Windows acceptance record for the isolated candidate based on source commit `4bde9f25e975efc5a5ccc8a3571cbd7b2e430750` (base tree `efd9ea26765fa593e2e4af00aff172740d57b1d8`). The reviewed candidate remains an uncommitted worktree; the base commit is not represented as the final modified source identity. See the local delivery report and SHA-256 inventory outside the package for the exact worktree binding.

## Findings

| Finding | Status | Implemented behavior and evidence |
|---|---|---|
| UF01 rollback preview lost `--rollback-of` | Closed (fix) | One argument builder supplies both apply and printed commands. Source regression captures and executes the CLI's actual command for existing/missing targets, `--only`, and preview-time unrelated edits. The exact installed-package test exercises the same semantic boundary. Target bytes, untouched file, journal/pin and safety-point assertions pass. |
| UF02 POSIX demo parser required PowerShell `&` | Closed for implementation; native POSIX unverified | Parser now validates platform-specific executable prefix and exact allowed arguments; negative command/argument cases remain. Windows source/package demo passes. POSIX output/parser is unit-tested, but no native Linux/macOS runner was available. |
| UF03 preflight refusal suggested nonexistent operation journal | Closed (fix) | Recover/inspect guidance is emitted only after verifying a durable valid journal. A no-journal refusal suggests a read-only doctor check. Tests execute the displayed diagnostic command and verify no journal is fabricated. |
| UF04 explicit `--with-seed` could publish success without seed | Closed (fix/refusal) | Explicit seed is required; absent DB, missing CLI, private-storage refusal, path limit or backup failure fails before publishing a successful generation. Optional collection can still publish an explicitly partial snapshot. Real SQLite strict tests and installed package seed/restore/integrity/rollback pass. |
| UF05 unreadable snapshot inventory looked empty | Closed (fix) | Missing (`ENOENT`), empty, unreadable (`ENOTDIR`/permission) and damaged metadata are distinct. Unreadable state exits nonzero and gives no create-snapshot recommendation; tests verify no repair/write side effects. |
| UF06 Bash quickstart broke on spaces | Closed (fix) | Both READMEs quote `TOOL_ROOT`; exact Bash commands ran in isolated paths containing spaces and non-ASCII characters. PowerShell instructions and installed entry were also checked. |
| UF07 installed docs links / entry source label | Closed (fix) | Required relative docs are included in the exact 23-file allowlist and verified after offline install; entry label is “CLI entry”. No tests, logs or private evidence enter the package. |
| UF08 inherited JavaScript properties became help topics | Closed (fix) | Help lookup accepts own declared topics only. `toString`, `constructor`, and `__proto__` return a controlled nonzero invalid-topic response; valid help has no project write side effects. |
| UF09 Windows SQLite staging path limit lacked usable diagnosis | Closed (safe refusal) | Stable `ESQLITE_PATH_LIMIT` maps to a sanitized explanation and retry guidance limited to a verified disposable copy at a shorter path. It does not move business data or publish a successful explicit seed generation. Windows real-SQLite and CLI refusal regressions pass. |

No user study was performed. These outcomes do not establish that a first-time user understands restore scope, saves time, or will reuse the tool.

## Final validation

- Windows 11 environment, Node `v22.22.2`, npm `10.9.7`, Git from the active environment, and the locally provisioned SQLite CLI `3.54.1`.
- Strict mode: `REQUIRE_SQLITE_TESTS=1`; only the test process PATH was extended with the Node and SQLite directories. `TEMP`, `TMP`, and `TMPDIR` were set to a short workspace-local directory because the restricted shell's default temporary location did not permit Git fixture creation.
- The 25 files matching `test/*.test.js` ran once each in six sequential, non-overlapping batches: **341 tests, 340 pass, 0 fail, 1 explicit skip, 0 cancelled, 0 todo**. The skip is the existing Windows symlink-capability case. Full logs and per-batch commands are in the local evidence directory.
- Strict SQLite tests: **44/44 pass**, overlapping the full suite. Focused usability/list suite: **19/19 pass**. These are separate subsets, not additive to the full-suite total.
- `npm run check:version`: pass (`1.4.0-rc.10`, contract rev21, schema v2). `npm run pack:check`: pass (23 allowlisted files, 0 unexpected). `npm run test:install`: pass from an offline tarball, `sourceFallback=false`; installed README links, demo, rollback-preview command, SQLite seed restore/integrity and rollback passed.
- Exact tarball SHA-256: `fda7dfad1175391bbecee2573e9c3dfc08365f9f48e49946d4dde56a687da5a1`.
- English/Chinese quickstarts ran in isolated synthetic projects. Exact installed CLI was also checked from a path containing spaces/non-ASCII characters.

The first test attempt with the restricted shell's default temp folder failed fixture setup with Git `Permission denied`; it is not counted as a product test failure. A subsequent attempt with a deep evidence temp path made four existing path-length-sensitive SQLite fixtures differ from their intended setup; that log is preserved. With short workspace-local temp, the same batch passed 56/56. The final full-suite count uses only successful final batches.

## Limits

Native Linux/macOS, hosted CI, other filesystems/ACLs, power loss, automatic process restart, application health, real business database recovery, and independent user comprehension/value are unverified. This report does not claim complete or cross-platform restoration. No remote write, release, or npm publish occurred.
