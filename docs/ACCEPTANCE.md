# Acceptance evidence and scope

## Historical candidate evidence

The project history includes the separately registered Windows candidate `1.4.0-rc.5` (contract revision 18, schema v2). Its source/install acceptance report recorded:

- Source serial suite: 310 total, 309 passed, 0 failed, 1 explicit Windows symlink-capability skip.
- Source SQLite strict: 37/37; installed SQLite strict: 15/15, using SQLite CLI 3.54.1.
- Installed R01/R02/R03 checks: 4/4; additional restore/prune interrupted-process checks passed in the source report.
- Exact prior tarball SHA-256: `4680178a2d7d0d3bbc9b19464724c971c2c03beaf45750798aec1717b5cd744a`.

These results are evidence for that registered candidate only. They are not the test result for a later commit. Raw machine logs and private directory mappings are intentionally kept outside the upload tree.

## rc.8 independent upload gate — failed

The independent test on `1.4.0-rc.8` supersedes the earlier author-side acceptance claims above for upload readiness. It recorded a 322-item strict suite with 316 pass, 5 fail, and 1 explicit skip; SQLite targeted tests were 14 pass / 3 fail; Windows CMD cases were 0 pass / 2 fail. Snapshot returned success with a skipped database layer after online backup failed, and installed `--with-seed` restore lacked the marker table. See the preserved independent report and logs. Those rc.8 results are history and are not evidence for rc.9.

## rc.9 local repair-candidate gate — passed with explicit limits

The rc.9 repair candidate was tested locally on Windows. A separate local delivery report binds the final source commit, clean-checkout results, per-file inventory and exact tarball digest; that report and raw machine logs are not part of this source tree or npm package.

- Targeted database-safety suite: 24/24 pass.
- Strict SQLite suite with real SQLite CLI 3.54.1 and `REQUIRE_SQLITE_TESTS=1`: 18/18 pass, including an open WAL writer and committed, uncheckpointed row data.
- Full serial suite: 325 total, 324 pass, 0 fail, 1 explicit Windows symlink-capability skip, 0 cancelled, 0 todo.
- `check:version`: pass (`1.4.0-rc.9`, contract rev21, schema v2).
- `pack:check`: pass (18 files, 0 unexpected).
- `test:install`: pass against the exact locally retained tarball; installed CLI was used without source fallback. SQLite `--with-seed` restore/integrity and database rollback were verified. Tarball SHA-256: `f31869a313f46e5574d466fe4022082b2359d4c9a333e7fbab2a01629f26de2d`.
- Windows CMD rollback special-path regression: 1/1 pass. Trusted external `.cmd` shim with a spaced path: 1/1 pass.

The only full-suite skip is `sec7c: symlinked FILE inside snapshot files/ -> restore refused`; this Windows account/filesystem did not expose the required symlink capability. It is not counted as a pass. The independent rc.8 report and all of its logs remain unchanged. The rc.8 WAL probe stopped before collector execution on `fs.promises.realpath` EPERM; rc.9 supplies new real-CLI WAL evidence, but that does not establish other platforms or filesystems.

These are local Windows source/package gates, not hosted Actions and not permission to create a remote repository, push, change visibility, create a Release, or publish to npm. Hosted CI, Node 22, Linux/macOS, other filesystem/ACL configurations, power-loss durability, real project-data recovery, user value and application health remain unverified.

Tests must run with a real `sqlite3` executable on `PATH` and `REQUIRE_SQLITE_TESTS=1`. A mocked CLI or skip does not count as the database gate.

## rc.10 local usability candidate — final Windows source/package evidence

The isolated usability candidate adds layered command help, a synthetic disposable A→B→A→B exercise, explicit partial/incomplete summaries, shell-specific next actions, and bilingual quickstarts. Contract revision 21 and snapshot schema v2 are unchanged. Detailed issue-by-issue evidence and batch logs are in the local handoff report referenced by the candidate register; raw logs are not part of the npm package.

- Final strict serial source suite: **341 total, 340 passed, 0 failed, 1 explicit skip, 0 cancelled, 0 todo**. All 25 `test/*.test.js` files were executed exactly once in six sequential, non-overlapping batches because the local shell limits a single command to 300 seconds. SQLite strict mode was enabled for every batch. The sole skip is the existing Windows symlink-capability test; the account/filesystem did not expose the required symlink capability.
- Final strict SQLite subset: 44/44 passed with SQLite CLI 3.54.1 and `REQUIRE_SQLITE_TESTS=1`; it includes an open writer, committed WAL capture, restore/integrity, seed refusal and Windows staging-path refusal. This subset overlaps the full suite and is reported separately.
- Final focused usability/list subset: 19/19 passed. Earlier broader targeted source set: 63/63 passed. These targeted counts overlap other suites and are not added to the full-suite total.
- `npm run check:version`: passed for rc.10/rev21/schema v2. `npm run pack:check`: passed with 23 allowlisted files and 0 unexpected files.
- `npm run test:install`: passed from a newly produced exact offline tarball under Node 22.22.2/npm 10.9.7. Installed CLI used no source fallback; packaged README links, demo, rollback-preview command, SQLite seed restore/integrity and database rollback passed. Tarball SHA-256: `fda7dfad1175391bbecee2573e9c3dfc08365f9f48e49946d4dde56a687da5a1`.
- English and Chinese Bash quickstart commands were executed in isolated projects with spaces/non-ASCII path characters; PowerShell quickstart and the exact installed CLI were also checked. Native Linux/macOS execution remains unverified; POSIX parser behavior has unit coverage, not native platform acceptance.
- No non-author operator participated. [The trial card](USABILITY-TRIAL.md) remains prepared; independent understanding, time saved, willingness to reuse, application health and real project data recovery remain unverified.

The initial strict attempt under the restricted shell's default temporary directory failed to create Git fixtures (`Permission denied`); it was not counted. A retry with a long evidence-directory temp root changed existing Windows SQLite path-length fixtures and produced four failures; after moving `TEMP`/`TMP` to a short workspace-local path, the same database/restore batch passed 56/56. The failed diagnostic logs are preserved outside the source tree. This does not alter the final test counts above.

The earlier rc.9 section remains historical. These are local Windows source/package results only, not hosted Actions, Linux/macOS, other ACL/filesystem combinations, power-loss durability, human usability or application-health evidence. No publish or remote action was performed.

## Limits

A passing local test suite cannot establish cross-platform restore, power-loss durability, real project data recovery, user value, or application health. The Windows symlink-capability case remains explicitly unverified.

## rc.11 CTF-01 diagnostic scope

rc.11 increments the package/tool version because the packaged CLI code changed; contract revision 21 and schema v2 remain unchanged. The public npm registry lookup returned 404 for the package name, and the public repository has no version tags, so rc.11 is not an existing published/tagged version. No package was published.

- Independent review evidence reproduced the issue: an 86-character synthetic Windows project path returned a successful compare with only a generic SQLite backup failure reason, while correctly stating schema and row data were not compared.
- The implementation reuses `ESQLITE_PATH_LIMIT` for optional collection, reports the known Windows staging journal limit and a safe shorter-disposable-copy suggestion, keeps database metadata/rows unavailable, and withholds private engine details.
- Required `--with-seed` behavior remains fail-closed with no successful generation. Ordinary optional collection remains partial/skipped. No database, sidecar, project state, lock, snapshot, or safety point is moved or removed automatically.
- Regression coverage includes a short-path successful live schema comparison, the 86-character real Windows compare path, output redaction and unchanged database/Git/snapshot state, unrelated error classification, and explicit-seed path-limit refusal. Run-specific logs are retained in the local delivery evidence directory, not in the package.
