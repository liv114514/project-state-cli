# Task-oriented diagnosis

`doctor --task` is a read-only, point-in-time checklist for the current working directory. It never searches parent directories, changes the working directory, creates project-state metadata, reserves a snapshot generation, or authorizes a write. A later snapshot or restore command performs its own checks.

## Supported tasks

```text
project-state doctor --task config-snapshot [--json]
project-state doctor --task config-restore --snapshot <name> [--json]
```

`config-snapshot` checks whether `.env` or `.env.local` is present and readable, whether the local storage and Git privacy boundaries can be inspected, and whether a lock, claim, or unresolved journal was observed. It does not read configuration contents. No applicable configuration returns `not-applicable`.

`config-restore` validates the named snapshot, its required artifacts, a clean supported Git state, and the selected configuration targets. A directory outside a supported Git worktree is a required issue (`GIT_REPOSITORY_REQUIRED`), because the restore operation requires that boundary. It does not perform the restore or create dry-run lock/pin metadata. SQLite is not part of this configuration-only task.

## JSON result schema v1

One valid invocation writes one JSON object to stdout. Runtime inability to verify a condition is represented as `unknown`; command syntax errors are sent to stderr and do not produce a JSON document.

Top-level keys are `resultSchemaVersion`, `toolVersion`, `command`, `task`, `projectContext`, `checks`, `summary`, `nextStep`, and `limitations`. The result schema version is independent of snapshot schema v2. `projectContext` discloses only `scope: current-working-directory`, `pathDisclosure: omitted`, and `gitRepository: yes|no|unknown`.

Each check has `id`, `state`, `required`, `reasonCode`, and a sanitized `message`. State is `ok|issue|unknown|not-applicable`. Stable reason codes distinguish missing snapshots, invalid generations, missing or damaged artifacts, unsupported schema, unavailable tools, permissions, unsafe paths, unsupported Git context, dirty Git state, and unresolved operations. Optional issues do not block the task; required issues produce `blocked`; otherwise required unknowns produce `unknown`; a task with no applicable required object is `not-applicable` only after required context checks pass; otherwise it is `ready`.

Exit codes: `0` means the inspection completed with `ready` or `not-applicable`; `1` means `blocked` or invalid arguments; `2` means a required condition is `unknown`. Exit 0 is not a write authorization.

`nextStep` is a structured object containing an action, command name, argument array, current-directory scope, confirmation/effect description, and a `revalidates` flag. It is display metadata only. It is not a shell string, must not be evaluated, and never includes `--yes`.

Example:

```json
{"resultSchemaVersion":1,"toolVersion":"1.4.0-rc.15","command":"doctor","task":"config-restore","projectContext":{"scope":"current-working-directory","pathDisclosure":"omitted","gitRepository":"yes"},"checks":[{"id":"snapshot.integrity","state":"ok","required":true,"reasonCode":"SNAPSHOT_VALIDATED","message":"Required snapshot artifacts passed integrity validation."}],"summary":{"state":"ready","requiredIssueCount":0,"requiredUnknownCount":0},"nextStep":{"action":"preview-config-restore","command":"restore","args":["before-change","--only","config","--dry-run"],"cwd":"current-working-directory","confirmation":"none-for-preview","effects":"may-create-and-release-lock-pin-metadata","revalidates":true},"limitations":["Readiness is a point-in-time observation."]}
```

Invalid example: `doctor --task config-restore --json` is missing `--snapshot`; it exits 1, writes a concise usage error to stderr, and does not create state.

The text and JSON renderers use the same result object. Outputs omit configuration values, key names, absolute project paths, private artifacts, database rows, SQL, host identity, raw tool stderr, and stack traces. JSON is local diagnostic output and is not automatically safe to publish. Git inspection rejects effective content filters before status and disables optional Git locks and filesystem-monitor hooks for this read-only task.

Readiness can become stale immediately. The actual command revalidates the project, artifacts, target state, and authorization. A ready result does not reserve a generation, freeze inputs, prove future restore success, or establish application health.
