# Release candidate gate — 1.4.0-rc.15

This is an audit-fixed local candidate, not a published release. Package/tool version is `1.4.0-rc.15`; contract revision 25 corrects task-diagnosis summary precedence and requires a supported Git worktree for config-restore readiness. Task diagnosis and read-only `list --json` / `show` inspection remain available; snapshot schema v2 is unchanged. Validation must be bound to this audit copy's exact tree and package bytes; prior R3 results apply only to rc.14. Hosted CI, cross-platform, user-trial, and release approval are not implied.

| Gate | Current status |
|---|---|
| CTF-01 behavior | Optional compare remains skipped/unknown and explains the Windows staging path limit; explicit seed remains a required failure; no automatic path migration |
| Task doctor | `config-snapshot` and `config-restore` share text/JSON results; checks are read-only and do not reserve a generation or authorize restore |
| Snapshot inspection | `list --json` and `show` share validated metadata; damaged and unknown entries are explicit; content and application health are not disclosed or inferred |
| Local source, strict SQLite and install gates | Bound to each frozen candidate commit in the local iteration record; not implied by this file alone |
| Hosted CI and POSIX demo | Not re-run for rc.13; prior runner evidence applies only to its recorded commit and matrix |
| Independent user trial and application health | Not run / unverified |

rc.9–rc.14 evidence is historical and applies only to each recorded tree. rc.15 source validation and remaining package/install gates are recorded in the isolated full-code-review report; the rc.10 usability record is retained as history in [usability acceptance](USABILITY-ACCEPTANCE.md). The trial card is [here](USABILITY-TRIAL.md). Independent user understanding and value, ACL/filesystem variation, power-loss durability, real project data recovery and application health remain unverified. Hosted matrix results apply only to their recorded commits and runner images. No npm publish or formal Release is authorized.
