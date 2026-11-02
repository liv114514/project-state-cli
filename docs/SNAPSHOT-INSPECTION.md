# Snapshot inventory and detail inspection

R2 adds read-only machine-readable inspection for scripts that need to show a user what a saved generation contains. The selected R3 contract uses inspection result schema v2; this is separate from snapshot schema v2.

## Commands

```sh
node bin/project-state.js list --json
node bin/project-state.js show before-change --json
```

`list --json` distinguishes an absent inventory, a readable empty directory, a readable inventory, an incomplete inventory, and an unreadable inventory root. Candidate names that satisfy the snapshot naming rule appear as rows even when their metadata is invalid, incomplete, or from an unknown future schema. Other directory entries are counted without publishing their names. A returned list is not silently filtered and marked complete.

`show <name>` reports the exact generation when validated, creation time, type, schema, layer collection status, artifact privacy and restore class, and whether stored bytes passed integrity checks. `supported` describes an implemented file/artifact restore path only. It does not establish that the current OS or project can apply the restore.

Both outputs omit file bytes, private artifact hashes and stored paths, configuration values, database rows, SQL, host details and raw error text. Per-layer summaries include supported-artifact, record-only-artifact and private-artifact counts; they do not expose private values. The commands do not inspect or change pin/journal ownership, repair metadata, migrate legacy formats, execute saved data, or write project state. Current restore prerequisites are `not-checked`; application health is `not-tested`. The JSON result schema version is independent from snapshot schema v2.

Status meanings:

- `verified`: metadata and required artifact integrity checks passed.
- `diagnostic-only`: legacy v1 metadata is readable, but it is unsupported for restore.
- `incomplete`: a required artifact is missing or declared layers are partial.
- `invalid`: metadata or artifact integrity failed.
- `unknown`: a check could not safely establish the format or access state.

List exits 0 when it can report the inventory, including explicit diagnostics; a missing `show` target exits 1; unsafe or unverifiable details exit 2. Invalid syntax exits 1.

A consumer example is available at [examples/inspect-snapshots.cjs](../examples/inspect-snapshots.cjs). It requires the snapshot name explicitly and never invokes restore.
