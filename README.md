# project-state Python candidate — lifecycle work

This repository is an isolated local engineering candidate based on the Python a47 source. It is not a published replacement for the separate Node.js project. The original a47 wheel and source remain unchanged and are kept outside the Git source tree.

The product records selected local project state, compares supported evidence, previews narrowly supported restores, and verifies eligible file and SQLite restore operations. It does not provide general workspace rollback, Git write recovery, automatic application restart, or existing SQLite database overwrite.

## Current work state

- Source baseline: Python `0.1.0a49`, contract revision 30, snapshot schema v2.
- Current source inventory: 139 plain files; exact worktree byte manifest and aggregate SHA-256 are in the sibling report. Five ignored `*.egg-info` metadata files and generated build output are excluded from the source identity.
- Windows installer prototype: transaction protocol 0.3.5, paired with the unchanged a49 wheel. Runtime staging writes an identity-bound owner receipt and external lease before extraction, supports read-only inspection of a provably owned incomplete stage, refuses to publish incomplete content, and permits a fresh verified retry while preserving the orphan. A verified complete stage can be rechecked and published by a later process. Orphan adoption and automatic cleanup are not implemented. The installer accepts an explicit isolated Python archive cache; offline runtime preparation is network-disabled and fails if that cache is missing or unusable. It provisions a pinned managed runtime and keeps it separate from product and project state. The prototype requires PowerShell 7+, does not edit global PATH, and is not a public bootstrap installer. Local synthetic validation records are kept in the accompanying candidate evidence package, not this source repository. See [installer ownership and lifecycle](INSTALLER-OWNERSHIP.md).
- No maintainer Git author identity was configured when this isolated repository was created. A commit will not be attributed to an invented identity.
- Allowlisted `.env` + `.env.local` batch recovery is implemented in the local candidate with new-process continuation and rollback interruption tests. It is per-file transactional, not atomic across both files. SQLite maintenance-window application integration is not complete.

## Windows engineering entry points

`installer/prepare-python-runtime.ps1` provisions a pinned CPython 3.12.13 build with the pinned uv binary into an explicit, new runtime directory and verifies the runtime tree before it is used. `installer/install-managed.ps1` composes that runtime with the transaction installer. These scripts are engineering candidates; see `INSTALLER-OWNERSHIP.md` for what they own and preserve.

The runtime is user-level and isolated. No global PATH or system Python selection is changed. Existing Python installations and project state are not installer-owned.

## Supported product boundaries

The a49 product contract remains revision 30 and supports selected configuration capture, comparison, preview, bounded configuration restore, SQLite online-backup capture, and restoration of an absent database destination. Git apply, prune deletion/recovery, hook lifecycle, and existing database overwrite remain unavailable or explicitly refused. Restoring files does not establish application health.

## Documents

- [Migration matrix](MIGRATION-MATRIX.md)
- [Installer ownership](INSTALLER-OWNERSHIP.md)
- [SQLite maintenance contract](SQLITE-MAINTENANCE-CONTRACT.md)
- [Later-stage roadmap](NEXT-STAGES.md)

No remote upload, package publication, release, or production project operation was performed for this candidate.
