## 1.4.0-rc.15 — audit fixes; not published

- Fix task-doctor summary precedence so required issues and unknowns cannot be hidden by `not-applicable`.
- Report config restore as blocked with `GIT_REPOSITORY_REQUIRED` outside a supported Git worktree.
- Forward explicit child-process environments so read-only Git inspection actually honors `GIT_OPTIONAL_LOCKS=0` and leaves index bytes unchanged.
- Correct list/show command help to identify JSON result schema v2; add help-contract regression coverage.
- Add regression tests for missing project context, non-Git restore preflight, and index immutability; contract revision 25, snapshot schema v2 unchanged.

## 1.4.0-rc.14 — candidate convergence and consumer boundary; not published

- Select the rc.13 implementation with contract revision 23 as the sole source candidate; retain its explicit snapshot inventory states, integrity projection, and task diagnosis behavior.
- Clarify command-scoped JSON schemas: task diagnosis remains result schema v1, snapshot inventory/detail move to result schema v2 with per-layer private-artifact counts and explicit consumer validation.
- Record that the alternate rc.13 candidate was not published and has no known external consumer; restore/storage behavior and snapshot schema v2 are unchanged.
- Add the R3 contract decision and migration boundary; contract revision 24, snapshot schema v2.

## 1.4.0-rc.13 — snapshot inspection API; not published

- Added `list --json` and `show <name> [--json]` over a shared, read-only snapshot inspection model.
- Inventory output distinguishes missing, empty, incomplete, and unreadable states; damaged and unknown entries remain diagnosable.
- Snapshot details expose validated metadata and artifact classes without file bytes, private digests, database rows, SQL, or application health claims.
- Added a minimal explicit-name consumer example; it never selects a snapshot automatically or invokes restore.
- Added contract revision 23; snapshot schema v2 is unchanged.

## 1.4.0-rc.12 — task-oriented diagnosis; not published

- Added read-only `doctor --task config-snapshot` and `doctor --task config-restore --snapshot <name>` checks with a versioned JSON result and text renderer from the same model.
- Kept task diagnosis scoped to the exact current directory; it does not create snapshot state, perform restore, or grant write authorization.
- Disabled optional Git filesystem-monitor hooks during read-only status inspection and retained effective filter rejection before status.
- Added safe check summaries for missing, damaged, legacy, and unsupported-schema snapshots without exposing private input values or paths.
- Added contract revision 22; public snapshot schema remains v2.

## 1.4.0-rc.11 — Windows live-compare diagnostics; not published

- Preserve the stable SQLite staging path-limit category for optional database collection and live comparison. The CLI now explains that database metadata/row data were not collected and recommends retrying only from a verified disposable copy under a shorter local path.
- Keep optional collection partial/skipped and explicit `--with-seed` failure semantics unchanged; no database, sidecar, or project state is moved automatically.
- Keep contract revision 21 and snapshot schema v2 unchanged.

## 1.4.0-rc.10 — usability candidate; not published

- Added concise global and per-command help without changing command authorization or recovery behavior.
- Added a disposable synthetic configuration demo that verifies A → B → A → B and executes the exact printed rollback command.
- Clarified partial snapshots, comparison unknowns, restore previews, and inventory integrity summaries.
- Reorganized bilingual quick starts with PowerShell and Bash examples; package contents now include the demo entry point.
- Contract revision remains 21 and snapshot schema remains v2; this candidate is not published to npm.

## 1.4.0-rc.9 — local acceptance repair candidate; not published

- Fixed Windows SQLite online backup staging paths that caused SQLite journal creation to exceed MAX_PATH; unsafe path lengths now fail before SQLite writes.
- Preserved ordinary partial collection while making explicit `snapshot --with-seed` fail without publishing a generation when a discovered database cannot be captured.
- Corrected Windows `.cmd` shim argument framing without enabling `shell:true`; CMD metacharacter-bearing inputs remain refused.
- Corrected the Command Prompt rollback regression launcher to quote its batch path while continuing to execute the exact printed rollback command.
- Added contract revision 21; public snapshot schema remains v2. Independent rc.8 upload-gate failures require final rc.9 source and install acceptance.

## 1.4.0-rc.8 — local repository-preparation candidate; not published

- Bound file replay after Git checkout to the verified post-checkout filesystem state while retaining pre-restore bytes in the private safety generation.
- Restricted resolved-operation staging cleanup to journals explicitly bound by resolvesOperationId.
- Added contract revision 20; public snapshot schema remains v2.
- Revalidated Windows serial tests, strict SQLite, tarball installation and exact CLI rollback.

# Changelog
## 1.4.0-rc.7 — private safety and install-verification candidate; not published

- Refused restore publication when target bytes or identity change after preflight; absent targets use exclusive publication and absent-state removal retires only the verified inode.
- Kept file compensation bound to staged/published identity and tracked Git checkout effects separately from temporary hook cleanup.
- Retired owner-bearing operation lock directories atomically before best-effort cleanup.
- Bound live SQLite schema comparison to exact observed bytes; row contents remain explicitly un-compared.
- Refused hook uninstall after wrapper edits, corrected collision suffix ordering, and made rollback command tests platform-aware.
- Added real local tarball installation acceptance and a CI step; hosted results remain pending.

## 1.4.0-rc.6 — private repository-preparation candidate; not published

- Prepared a source-only Git repository import from the separately registered 1.4.0-rc.5 candidate.
- Corrected the CI version check and pinned the two GitHub Actions to verified release commits.
- Replaced package-facing setup guidance with bilingual local-tarball instructions, synthetic configuration examples, and explicit recovery limits.
- Added repository, package-content, and version checks. No snapshot schema or contract semantics were intentionally changed.
- This candidate has not been published to npm. Its final source, package, and clean-checkout results are recorded outside the upload tree until tied to an exact commit.

## Prior local engineering candidate

The source behavior and contract in this import are based on the registered 1.4.0-rc.5 candidate (contract revision 18, snapshot schema v2). Its Windows source/installed test totals and package hash are historical evidence for that candidate only. They are not test results for this repository import. See `docs/ACCEPTANCE.md` for the precise distinction.
