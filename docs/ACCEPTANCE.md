# Acceptance evidence and scope

## Historical candidate evidence

The imported implementation is based on the separately registered Windows candidate `1.4.0-rc.5` (contract revision 18, schema v2). Its source/install acceptance report records:

- Source serial suite: 310 total, 309 passed, 0 failed, 1 explicit Windows symlink-capability skip.
- Source SQLite strict: 37/37; installed SQLite strict: 15/15, using SQLite CLI 3.54.1.
- Installed R01/R02/R03 checks: 4/4; additional restore/prune interrupted-process checks passed in the source report.
- Exact prior tarball SHA-256: `4680178a2d7d0d3bbc9b19464724c971c2c03beaf45750798aec1717b5cd744a`.

These results are evidence for that registered candidate only. They are not the test result for this repository import, `1.4.0-rc.6`, or a future commit. The raw machine logs and private directory mappings are intentionally kept outside the upload tree.

## This repository import

The local candidate identity and current execution evidence are recorded in the local, ignored `evidence/FINAL-ACCEPTANCE.md` and `evidence/final-manifest.json` directory. The final serial source run on Windows 11 / NTFS used Node v24.19.0, npm 11.17.0, Git 2.55.0.windows.5 and SQLite 3.54.1 with `REQUIRE_SQLITE_TESTS=1`: 322 tests, 321 passed, 0 failed, 1 explicit Windows symlink-capability skip, 0 cancelled, 0 todo. The standalone strict SQLite suite passed 17/17. `npm run check:version`, `npm run pack:check`, and `npm run test:install` passed for `1.4.0-rc.8`; the installed package exercised file snapshot/restore/rollback and real SQLite seed restore, integrity check and rollback.

These results are repeated from the final local commit in a clean, ordinary checkout and are bound to its tree and retained tarball. They are not hosted Actions. Hosted GitHub Actions are not run before the first upload and must be reported as not run.

Tests must run with a real `sqlite3` executable on `PATH` and `REQUIRE_SQLITE_TESTS=1`. A mocked CLI or skip does not count as the database gate.

## Limits

A passing test suite cannot establish cross-platform restore, power-loss durability, real project data recovery, user value, or application health. The one Windows symlink-capability skip in the earlier candidate remains explicitly unverified.
