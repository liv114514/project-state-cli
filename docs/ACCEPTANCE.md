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

## Limits

A passing local test suite cannot establish cross-platform restore, power-loss durability, real project data recovery, user value, or application health. The Windows symlink-capability case remains explicitly unverified.
