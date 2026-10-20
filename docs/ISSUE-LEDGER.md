# Repository preparation issue ledger

This ledger records the repository-preparation fixes integrated for `1.4.0-rc.9` (contract revision 21, snapshot schema v2). Independent rc.8 findings are retained below. Machine logs are maintained outside the upload tree; test source and the current acceptance summary are included here.

| ID | Severity | Finding | Disposition | Evidence |
|---|---|---|---|---|
| CR01 | P1 | Restore compensation could remove a path created or changed by another process after preflight. | Fixed. Compensation is limited to files with durable post-publication identity proof; exclusive publication and identity-bound retirement preserve later external objects. | `test/critical-restore-boundaries.test.js`; `ACCEPTANCE.md` |
| CR02 | P1 | Compensation could replace an externally changed file with identical bytes but a different identity. | Fixed. Device/inode and digest/size proofs are checked; unresolved identity keeps the safety point. | `test/critical-restore-boundaries.test.js` |
| CR03 | P1 | A Git checkout failure after HEAD movement could leave the repository at the selected commit. | Fixed. Checkout attempt/success is journaled and actual HEAD attachment, index, refs and files are reconciled before compensation is reported. | `test/critical-restore-boundaries.test.js`; restore-safety tests |
| CR04 | P2 | Lock release could leave an ownerless active lock if cleanup failed. | Fixed. Owner-bearing lock directories are atomically retired before best-effort deletion. | `test/snapshot-storage.test.js` |
| CR05 | P2 | Live SQLite schema artifacts were not consistently integrity-bound or compared. | Fixed. Live schema bytes carry exact size/digest and supported schema differences are reported; row contents remain explicitly un-compared. | `test/db.test.js` |
| CR06 | P2 | Printed rollback tests depended on PowerShell and were not portable. | Fixed. Shared helper runs the exact emitted rollback text through the platform shell. | `test/helpers.js`, `test/db.test.js` |
| CR07 | P2 | Hook uninstall could overwrite a later third-party modification. | Fixed by exact generated-wrapper identity check; modified wrappers are preserved and uninstall refuses. | `test/hook.test.js` |
| CR08 | P2 | No clean offline install test proved that the packed CLI itself restores and rolls back. | Fixed. `npm run test:install` packs, installs the tarball into a fresh prefix and exercises file and real SQLite restore/rollback. | `scripts/verify-install.cjs`; `ACCEPTANCE.md` |
| CR09 | P2 | Same-second snapshot name collision handling did not reliably parse and allocate suffixes. | Fixed. Managed auto/hook names use validated numeric suffixes with stable bounded allocation. | `test/cli-correctness.test.js` |
| E01 | P1 | `filter=unset` / `filter=unspecified` with only a clean driver could execute during Git status. | Fixed. Effective filter checks run over HEAD and index paths before status; active clean-only drivers are rejected. | E01 subtests in `test/restore-safety.test.js` |
| E02 | P1 | A staged addition absent from HEAD could escape filter preflight. | Fixed. Full index path enumeration precedes status and filter checks include staged-only paths. | E02 subtests in `test/restore-safety.test.js` |
| E03 | P2 | The repository contains repeated low-level data reads in database inspection. | Measured and reduced repeated per-table CLI work by batching row counts; large-database Buffer streaming redesign was not undertaken because it crosses snapshot/validation/restore integrity boundaries and is outside the upload-preparation scope. | `test/db.test.js`; `ACCEPTANCE.md`. Large-file memory scaling remains unmeasured. |
| E04 | P3 | Suggested helper deduplication could remove behavior still consumed by restore modules. | Reviewed; no duplicate core implementation was removed because compatibility wrappers remain used. | Source reference review; no duplicate implementation was removed. |

The Windows symlink-capability subtest remains an explicit skip. Hosted CI, Node 22, Linux/macOS, real project trial, power-loss durability and application health are not established by this ledger.

## Independent rc.8 upload-gate findings and rc.9 disposition

| ID | Severity | Finding | Disposition | Evidence |
|---|---|---|---|---|
| AT-01 | P1 | SQLite online backup failed in a long Windows staging cwd; ordinary snapshot returned success with database skipped, and installed `--with-seed` lacked marker rows. | Fixed. Private collector staging shortens the operation-local path; Windows preflights the adjacent journal path and refuses unsupported lengths before invoking SQLite. Ordinary capture remains partial with an explicit skipped reason. A discovered supported database plus failed explicit `--with-seed` capture now exits 2 and does not publish a generation. | `test/database-safety.test.js`; `test/db.test.js`; `ACCEPTANCE.md` |
| AT-02 | P2 / harness | Command Prompt rollback regression failed at its PowerShell `Start-Process` wrapper. | Classified as a test-launcher quoting bug: `Start-Process -ArgumentList` flattened an unquoted batch path containing spaces. The test now quotes that single batch-file argument and still executes the emitted rollback command unchanged. | `test/restore-safety.test.js`; `ACCEPTANCE.md` |
| AT-03 | P2 | Trusted `.cmd` shim with a valid path containing spaces failed to start. | Fixed. `cmd /s /c` receives a validated, outer-quoted command string with `windowsVerbatimArguments`; all CMD metacharacter-bearing arguments remain refused. The regression shim path contains spaces and marker files prove which process ran. | `lib/utils.js`; `test/security.test.js`; `ACCEPTANCE.md` |

The independent WAL writer attempt ended at `fs.promises.realpath` with EPERM before the collector. It remains an environment-blocked, unverified WAL result, not a confirmed product defect and not a pass. The independent report and its raw logs are preserved unchanged.
