# Candidate contract revision 30

This contract belongs to the unpublished Python candidate `0.1.0a48`; it does not revise the separate Node.js rc.15 line.

## Versioned outputs

- Snapshot format: schema v2, unchanged from a37. Public and private generations remain paired; no automatic migration or repair of unknown formats is supported.
- General `doctor --json`: `resultSchemaVersion: 1`, `command: "doctor"`, `mode: "general"`, `tools`, `checks`, `summary`. It is read-only and does not assert restore readiness or application health.
- Task `doctor --task ... --json`: `resultSchemaVersion: 1`, `command: "doctor"`, `task`, and readiness checks. It does not run install, migration, or application scripts.
- `list --json` and `show NAME --json`: result schema v2. Nonzero exit status may accompany a useful diagnostic JSON object; consumers must preserve both the process exit and parsed state.
- `recover --inspect --json`: operation-specific result schema v1. An inspect result is diagnostic, not permission to perform an action; only advertised actions backed by validated records are supported.

## Write boundaries

Restore and recovery writes are enabled only on verified Windows publication semantics. Other platforms retain read-only inspection where supported and reject mutations before lock, journal, pin, or business-target writes. Database restore creates only a missing root-level SQLite target and refuses existing target/sidecars. Config apply supports a single `.env`/`.env.local` target using journal schema v1, or an allowlisted batch containing those two targets using journal schema v2. Batch progress is per target and is recoverable by a later process only when owner claims, file identities, hashes, and monotonic journal transitions validate. Per-file publication is not an atomic multi-file view; a crash may leave a mixed state until a verified continue or rollback finishes. `--yes` authorizes the reviewed mutation; no interactive confirmation is implemented.

## State and compatibility

The Python state root is separate from Node `.project-state`. The state layout is Python-specific; this candidate does not migrate or delete prior state. Node and Python journals are not interchangeable. Interrupted operations must be handled by the originating runtime. Ambiguous or legacy unbound journals are inspection-only or rejected for writes.

State-root layout v1 and the existing three-field `state-root.json` payload remain unchanged. New roots are assembled in a unique same-parent container and include `state-root.initialization.json` before no-replace publication. That proof binds the project/runtime/layout, a fresh initialization ID, the container's device/file identity, the identity of `state-root.json`, and its SHA-256. The proof is optional when reading legacy roots so older valid roots remain readable; if present but malformed or mismatched, the root is rejected and preserved. New initialization is currently enabled only on the verified Windows `os.rename` no-replace path. Unpublished residue is not automatically adopted or deleted. A valid published root interrupted before return is re-read and validated by the next process. This does not guarantee power-loss durability.

For a new project with no Python state, `state-location show` and `check` are read-only. `state-location init PATH` may register one explicit root only when the selected root is absent, outside the project, on the same actual volume, and its owner/ACL can be verified without changing permissions. One resolver routes every Python state lookup through the active record. Existing default/legacy state cannot be switched or migrated. Pending or damaged registration blocks normal access; an exact same-path retry may resume only token-bound transaction evidence. Unknown residue is preserved. The old a45 reader rejects the new control marker rather than silently creating parallel state.

The Python SQLite engine must be version 3.51.3 or newer for explicit online backup and database restore. Older engines are reported by `doctor` and refused before database transaction work; the tool does not install or replace SQLite.

Contract revision 28 added the `state-location show|check|init` CLI boundary and the SQLite engine minimum. Revision 29 makes the existing Windows path limit explicit for every derived state-location control/data publication path: initialization and pending resume refuse before creating a lock, stage, marker, or selected root when any derived path exceeds the supported limit. Snapshot schema remains v2; doctor/list/show JSON schema versions remain unchanged.

Revision 30 adds an allowlisted two-target configuration restore journal (schema v2), with per-target identity-bound publication/compensation progress and cross-process continuation/rollback. Snapshot schema remains v2; doctor/list/show JSON schemas remain unchanged. Existing v1 single-target journals remain readable and retain their prior recovery path.
