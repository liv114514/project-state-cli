# Candidate productization matrix

This matrix maps the existing Python a47 implementation and the current lifecycle work. It distinguishes an existing product path from a new installer prototype and from future recovery work.

| Capability | Existing implementation | New work in this candidate | Input/output and side effects | State |
|---|---|---|---|---|
| CLI parsing/help/version | `core/src/project_state/cli.py` | none yet | argv → structured result/exit code; read-only unless a write command is selected | a47 baseline preserved |
| External process invocation | `core/src/project_state/process.py`, installer PowerShell process wrappers | managed runtime wrapper uses argument arrays and a bounded timeout | starts pinned uv, Python, or installer process; no shell command concatenation | installer path exercised locally |
| Paths/file identity | `core/src/project_state/foundation/paths.py`, `filesystem.py` | runtime root uses Windows reparse and file identity checks | identity/hash proof around runtime and project files | Windows only for write candidate |
| Capture/collectors | `core/src/project_state/capture.py`, `collector/`, `dashboard/` | none | selected project metadata and private artifacts | a47 baseline preserved |
| Snapshot storage/schema | `core/src/project_state/foundation/storage.py`, `core/src/project_state/snapshot.py` | none | schema v2; public/private generation pair | a47 baseline preserved |
| Artifact validation | core foundation/storage validators | runtime script adds an installer-runtime tree receipt | rejects path, type, size, identity, or digest mismatches | runtime receipt prototype exercised |
| Locks, pins, journals | core foundation and recovery modules | installer transaction journal remains separate from business recovery journals | state-root side effects under their respective roots | package install lifecycle exercised |
| Single-config restore/recovery | `core/src/project_state/recovery/config.py`, `restore_transaction.py`, `resolver.py` | multi-config operation not yet implemented | allowlisted target only; single-target transaction | a47 single-target capability retained |
| Git protection | `core/src/project_state/recovery/git.py`, `restore_git.py` | no Git write recovery | inspect/preview and refusal rules | a47 boundary retained |
| SQLite | `core/src/project_state/recovery/sqlite.py`, `database.py` | maintenance-window adapter is a separate contract | online backup; absent-destination restore; existing-target overwrite refused | a47 baseline; application overwrite unsupported |
| Compare | `core/src/project_state/compare.py` | none | supported config/private-byte comparisons | a47 baseline preserved |
| Diagnostics | `doctor.py`, `list.py`, `show.py`, `recover.py` | none | read-only output where specified | a47 baseline preserved |
| Prune | `prune.py` | no deletion or recovery added | diagnostic/refusal only | unavailable for deletion |
| Hook | `hook.py` | no lifecycle added | external hook behavior preserved by boundary | unavailable |
| Windows installer | historical `installer/install-core-prototype.ps1` | `prepare-python-runtime.ps1`, `install-managed.ps1` | isolated runtime plus versioned product environments, active shim and receipt; protocol 0.3.5 binds staging to an owner receipt and external lease | deterministic stage checks: 15 PASS, 0 FAIL, 1 BLOCKED hardlink precondition; incomplete stages remain preserved, not automatically adopted/cleaned; not a release installer |
| Build/receipt | `core/pyproject.toml` and historical a47 wheel | Git root and candidate docs created | source and package identities remain distinct | commit waits for verified author identity |

## Allowed dependency direction

Contracts and ports define cross-module shapes. Foundation may not import application, capture, recovery, dashboard, or installer code. Recovery and capture may not import one another's private implementation. Application coordinates through published ports. CLI and Dashboard may render or consume results but may not implement recovery transactions. Within one business module, private helper sharing is acceptable only when the helper's owner and invariant are explicit; it does not create a public cross-module API.

## Versioning

This work began from product a47 (contract revision 29, snapshot schema v2). The current local recovery candidate is a49 (contract revision 30, snapshot schema v2); installer and recovery journal versions remain distinct from snapshot schema. The a48 batch recovery behavior and a49 version identity require rebuilt wheel/sdist artifacts and cannot reuse the a47/a48 package identity. Runtime download-cache and offline mode are installer protocol behavior; they do not change snapshot or recovery journal formats.
