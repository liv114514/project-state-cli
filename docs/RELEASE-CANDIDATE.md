# Release candidate gate — 1.4.0-rc.11

This is a local diagnostic closeout candidate, not a published release. Package/tool version is `1.4.0-rc.11`; contract revision 21 and snapshot schema v2 are unchanged. It retains the rc.10 usability work and adds a stable, safe diagnosis for the known Windows SQLite staging journal path limit during optional compare.

| Gate | Current status |
|---|---|
| CTF-01 behavior | Optional compare remains skipped/unknown and explains the Windows staging path limit; explicit seed remains a required failure; no automatic path migration |
| Local source, strict SQLite and install gates | Run against the frozen rc.11 commit; results are bound in the local closeout record |
| Hosted CI and POSIX demo | Check the review pull request's commit-specific Actions run. The matrix covers Ubuntu, Windows, and macOS with Node 22 and 24; results do not cover every OS release or filesystem. |
| Independent user trial and application health | Not run / unverified |

rc.9 and rc.10 evidence is historical. Record rc.11 evidence in [acceptance](ACCEPTANCE.md); the rc.10 usability record is retained as history in [usability acceptance](USABILITY-ACCEPTANCE.md). The trial card is [here](USABILITY-TRIAL.md). Independent user understanding and value, ACL/filesystem variation, power-loss durability, real project data recovery and application health remain unverified. Hosted matrix results apply only to their recorded commits and runner images. No npm publish or formal Release is authorized.
