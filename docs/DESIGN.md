# Current design summary — 1.4.0-rc.9

The implementation contract is [CONTRACTS.md](CONTRACTS.md), revision 21 (public snapshot schema v2). Do not edit its fields or semantics without a versioned contract change and notice to consumers. This document summarizes the design; it does not replace the contract or platform-specific evidence. Current import validation is tracked separately from historical candidate evidence in [ACCEPTANCE.md](ACCEPTANCE.md).

## Snapshot model

Schema v2 snapshots are immutable public/private generations connected by a `current.json` pointer. Each generation has a manifest and an allowlisted artifact inventory. The inventory declares each artifact's layer, kind, privacy, required status, storage-relative path, digest, size, and restore policy. Restore validates both generations, declared artifacts, full directory membership, file identity and paths before mutating the project. Hashes detect changes; they do not authenticate the snapshot author.

Public metadata does not include private values, private hashes, SQL text, absolute source paths, or low-entropy private data digests. Environment/config source copies, all database metadata and bytes, and rollback copies are private plaintext under `.project-state/secrets/` or private staging. This storage is not encryption or access control.

Schema v1 is diagnostic-only. It is never restored, automatically migrated, moved, or deleted. Older v1 locations may contain database bytes in a formerly public path; users must treat old state as private and manually inspect it before sharing or migrating.

## Restore boundary

Restore requires the repository root, a supported ordinary Git worktree, successful Git probes, a clean index and worktree, locally available target Git objects, and complete valid v2 artifacts. `--force` cannot bypass dirty or uncertain Git state. Linked worktrees, submodules, sparse checkouts, missing objects, unsupported filters/hooks, and unsafe external command paths are refused. A saved attached branch is reattached only if its ref still points to the saved commit; otherwise the commit is checked out detached. Saved detached state remains detached. Existing refs are never moved. All declared files are replayed after checkout and final Git/file state is verified; CLI reports the verified HEAD mode.

Uncommitted work is not generally backed up. A command-provided rollback uses the restore operation journal and `--rollback-of <operationId>` to prove the current dirty paths, bytes, existence, HEAD, refs, and index still match changes from that operation. It refuses unrelated or externally changed work. This is a narrow rollback path, not a general force option.

Restore results distinguish refusal, verified restoration, failure with verified rollback, and incomplete rollback. Restore temporary bytes are staged under the private per-operation staging area and tied to a durable operation journal. Interrupted `applying` and `verifying` phases can be compensated only when target, Git and private staging identities match their proofs. A cleanup failure after final verification is recorded as `cleanupPending`; it does not reverse the verified business state, and any unresolved pin remains protective. The operation journal and persistent snapshot pins preserve recovery evidence on uncertain failure. A successful restore verifies supported project-state operations only; it does not establish application health.

## SQLite boundary

SQLite collection uses a trusted CLI online backup mechanism in short, private operation staging. `--with-seed` is explicit consent to store a complete consistent private binary backup; if a discovered database cannot be captured, that command fails without publishing a generation. Ordinary snapshot may continue with a clearly skipped database layer. Schema, row counts, and integrity metadata describe a successful backup. SQL/schema text and row metadata are record-only and are never executed.

Restore can create a missing database target from a validated private binary. It refuses to replace any existing database or target with `-wal`, `-shm`, or `-journal` sidecars. It verifies the created file, expected schema/row metadata, digest, and `PRAGMA integrity_check`. There is no schema-only database restore and no general database replacement.

## Other layers

Runtime and dependency observations may include declared pin/lock files, but the tool does not install or switch runtimes or dependencies, run package scripts, or guarantee registry/native module availability. Docker observations are record-only; volumes, images, containers, and services are not restored. Snapshots are records, not health checks.

## Lifecycle and safety

Operations use project-state locks, operation journals, immutable generation publication, and pins. File restore records a staged file identity before rename and persists each applied target. `recover <operationId> --inspect` is read-only for interrupted restore and snapshot operations. `--compensate --yes` reclaims only a verified stale local operation lock: for restore it invokes exact safety-point rollback; for snapshot it verifies journal ownership and pointer/generation state, then records a safe resolution without deleting generation or staging data. Ambiguous Git, database, target, lock, journal, or pointer states remain retained for manual handling. Pruning uses recorded time, kind, validated generation identity, and protection state; name prefixes alone do not authorize deletion. Invalid, current, pinned, and journal-referenced generations are retained. Cross-process SQLite locking, filesystem-wide atomicity, and power-loss durability beyond the explicit contract are not claimed.

For exact fields, APIs, errors, validation order, and refusal conditions, follow [CONTRACTS.md](CONTRACTS.md). For the current evidence and release gates, see [RELEASE-CANDIDATE.md](RELEASE-CANDIDATE.md).
