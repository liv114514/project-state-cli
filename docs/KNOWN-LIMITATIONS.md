# Known limitations

- The tool is not a full machine or application backup. It records selected state and restores only validated, explicitly supported artifacts.
- Uncommitted source, staged edits and untracked files are not general backup objects. Restore refuses when overwritten data cannot be fully protected; `--force` does not bypass that boundary.
- Git restore supports a narrow set of ordinary repository states. It does not move refs. Linked worktrees, unsupported filters/hooks and uncertain Git states are refused.
- Local private artifacts are plaintext. The tool does not encrypt them or provide access control. Hashes do not authenticate the snapshot author.
- Schema v1 is diagnostic-only and is not migrated or automatically deleted. Unknown future schema versions are refused.
- SQLite schema-only capture does not restore rows. Row capture requires `--with-seed` and a real SQLite CLI. Restore only creates a missing target; existing databases and sidecars are refused.
- Windows SQLite staging preflights the generated backup's temporary journal path and refuses lengths at the legacy path limit. A refusal is explicit: ordinary optional collection may commit with the database layer marked skipped, while a requested `--with-seed` capture fails without publishing a generation.
- SQL is recorded, never executed. No database engine other than the supported SQLite CLI path is claimed.
- Docker data/runtime is record-only. Dependencies are not installed or switched.
- Recovery does not automatically restart an app. Correct restored files do not establish app health.
- Windows local engineering evidence does not establish hosted CI or recovery behavior on Linux/macOS, other filesystems, ACL configurations, or after power loss.
- The project has not completed a consenting non-author trial on two authorized disposable projects. User understanding, time saved, and willingness to reuse are not established.
