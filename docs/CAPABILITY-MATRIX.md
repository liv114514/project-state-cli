# Current capability matrix

Candidate: `1.4.0-rc.11`, contract revision 21, snapshot schema v2. This matrix describes implemented boundaries; it does not claim that every platform or application has been validated.

| State | Record/compare | Restore | Validation boundary |
|---|---|---|---|
| Git identity, refs, index/worktree cleanliness | Record and compare selected metadata | Supported clean ordinary-repository checkout only; refs are not moved | Final Git state is checked; general uncommitted-work recovery is unsupported |
| Selected configuration files | Record private source bytes; compare value changes without revealing values | Validated v2 config artifact; selective restore supported | Bytes and Git state are checked; user must assess application behavior |
| Dependency manifests/pins | Record supported declared files | Only supported complete file pairs and supported modes | Does not install packages, switch runtimes, or prove registry/native availability |
| SQLite schema and metadata | Record; data comparison may be explicitly incomplete | Schema-only does not restore rows | Ordinary snapshots can mark the database layer skipped when the CLI/staging/backup is unavailable; the reason states data was not collected |
| SQLite row data | Only with explicit `snapshot --with-seed`; consistent binary backup is private | Can create a missing target and verify schema, rows, digest, and integrity | A discovered database whose seed backup fails makes `--with-seed` fail without publishing a generation. Existing target and sidecars are refused; no general replacement |
| Docker observations | Record selected metadata | Not restored | Containers, images, volumes and services remain external state |
| Application health/processes | Not established | No automatic process restart | File correctness does not prove the app runs |

## Trust and privacy

- Private files and full database backups are local plaintext under `.project-state`; this is not encryption or access control.
- Snapshot hashes detect accidental changes. They do not authenticate who created the snapshot.
- Schema v1 is diagnostic-only. Unknown future schemas and damaged required artifacts are refused for restore.
- Git state that cannot be fully protected is refused even with `--force`.
- See [contract](CONTRACTS.md), [design](DESIGN.md), and [known limitations](KNOWN-LIMITATIONS.md).

## Verification status

The rc.11 local candidate includes CTF-01 diagnostics for the known Windows SQLite staging path limit; optional compare remains explicitly skipped and does not claim schema or row comparison. See [acceptance history and current scope](ACCEPTANCE.md). Hosted CI, Linux/macOS recovery, other filesystems, real ACL equivalence, power-loss durability, non-author user value and application health remain separate questions until verified.
