# Product lifecycle roadmap and admission gates

## P0 — source and build provenance (local gate passed; unsigned)

The 142-file a49 candidate is frozen in local commit 5033ff6d00e6b46852be33f2ab103352d28995a1, tree 55b24dd258b022d7b716821ecf800da89b9acfb6. Its source manifest aggregate is 62912ff4933f668b713da8750347e689ded5ddfdc8fd7b63a0ce4e1c08cc5025. An offline clean build from that exact tree installed in a fresh venv; CLI version/help/module-origin checks passed and all 66 wheel members matched the registered a49 wheel. The commit is unsigned and local only; this is not hosted CI, push, or publication.

## P1 — Windows lifecycle (bounded synthetic checks passed; prototype limits remain)

The a49 candidate adds explicit isolated cache binding and offline runtime preparation to the a48 lifecycle. On Windows PowerShell 7.6.9, the exact a49 wheel passed the fresh offline managed-wrapper install and installed command version check; empty-cache and missing-cache-path cases were refused without publishing a runtime (4/4). The exact installed wheel's serial suite ran 189 tests: 185 passed, 0 failed, 4 explicit host/reference skips, with the required read-only a38 manifest fixture bound by its SHA-256. A fresh installed-entry journey later passed 12/12 in the current non-elevated Windows session, including a synthetic project/install path with spaces and Unicode; this is not a fresh Windows profile or an independent-user trial. Online Python bootstrap is separately BLOCKED_ENVIRONMENT after exact pinned uv encountered DNS error 11001; no final roots were published and the failed stage is preserved. The two a47 symlink cases are BLOCKED_PRECONDITION before test start (`WinError 1314`, no symlink-capable token). The full installer fault/interruption matrix remains incomplete, including authenticated abandoned-runtime-stage cleanup/adoption. The wrapper does not edit PATH. These are local synthetic results; detailed execution evidence is maintained with the candidate closeout package and is not linked as if it were part of this source tree.

## P2 — multi-config recovery (implemented for the allowlist; bounded tests passed)

Limit targets to `.env` and `.env.local`. Validate every source and target before writes, create one safety generation, persist one immutable multi-target plan, then journal each target intent and publication proof. Continue or reverse only identities proven to belong to the operation. Verify all selected targets at the end. Per-file replacement can expose a mixed view; atomic visibility requires application cooperation.

## P3 — maintenance-window SQLite (mechanism only; no adapter selected)

The live-WAL `Connection.backup` mechanism experiment passed, but it has no application maintenance fence. The state tool itself cannot provide an application-specific writer drain. Official-documentation evaluations found Gitea and Linkding require coordinated non-database state, and Miniflux documents PostgreSQL rather than SQLite; no suitable SQLite application target is selected. No application was installed and no unrelated user directories were scanned. Keep existing-database overwrite disabled. The next P3 step is to identify an explicitly disposable app with a documented stop-write/drain/close/resume lifecycle and a restore unit within the adapter boundary, then validate the contract before implementing support.

## Design-only later stages

- **Git write recovery:** define HEAD attachment, refs, index, tracked/untracked/ignored data and filters before implementation; start with a small protected scope, never `reset --hard` as a substitute for a safety plan.
- **Prune:** build a reference graph from generations, pins, journals, recovery claims and install versions; plan and recheck under lock; quarantine before irreversible deletion.
- **Hooks:** preserve external hook bytes and exit behavior; tool snapshot/log failure must not block commits; install/remove only verified owned content and do not enable by default.
- **Linux/macOS:** begin with read-only diagnostics and package/install checks, then separately test links, permissions, locking, no-replace publication, fsync and interruption. Do not infer write support from Windows tests.

No remote upload, package publication, release, or application-specific migration occurs by completing a local stage.
