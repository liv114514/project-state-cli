# Release candidate gate — 1.4.0-rc.9

Private local repair candidate only; not a release. Package/tool version `1.4.0-rc.9`, contract revision 21, snapshot schema v2. Local source/package upload gates passed on the isolated modified worktree. No push, remote repository creation, visibility change, Release, or npm publish is authorized or performed.

The prior rc.8 candidate did not pass the independent local upload gate. Its version and package-allowlist checks passed, but SQLite snapshot/installed seed restore failed and two Windows CMD tests failed. rc.9 is a separate repair candidate; its own final source, SQLite, pack and exact-tarball install results are recorded in the local handoff report and evidence bundle.

| Gate | rc.9 status |
|---|---|
| AT-01 SQLite staging and explicit seed outcome | Passed locally: strict SQLite 18/18; install package seed restore/integrity and rollback verified |
| AT-02 Command Prompt printed rollback regression | Passed: full suite plus targeted CMD path regression; launcher quoting fixed without altering the printed rollback command |
| AT-03 trusted `.cmd` shim with a spaced path | Targeted regression passed; marker checks establish the external shim ran and project-root shim did not |
| Version and contract | Passed: `1.4.0-rc.9`, contract rev21, schema v2 |
| npm allowlist and exact installed tarball | Passed: 18 files, 0 unexpected; exact tarball installed offline, no source fallback |
| Full serial suite, strict real SQLite | Passed: 325 total / 324 pass / 0 fail / 1 explicit skip; SQLite 18/18 |
| Hosted Actions, Node 22, Linux/macOS, ACL/filesystem matrix | Not run / unverified |
| Independent user trial and application health | Not run / unverified |

The rc.8 WAL attempt stopped at an environment `realpath` EPERM before database collection. rc.9 has new evidence from a real SQLite process with an open writer and uncheckpointed committed data; see the local handoff report. The old independent report and logs remain unchanged. This does not establish hosted or cross-platform behavior, and does not authorize any remote or public action.
