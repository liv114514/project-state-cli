# project-state

**Record selected project state, compare changes, and restore an explicitly supported subset.**

**简体中文简介：** project-state 是一款本地命令行工具，用于保存选定的项目状态、查看变化，并在安全检查通过时恢复明确支持的工件。它不是完整备份或应用健康检查工具，也不会自动重启应用。详见[中文版文档](README.zh-CN.md)。

## Status and requirements

The current candidate is `1.4.0-rc.11`; it is not published to npm. Contract revision 21 and snapshot schema v2 are unchanged. Node.js 22+ and Git are required. SQLite row capture and strict database tests require a real `sqlite3` CLI. There are no runtime npm dependencies, but filesystem and platform behavior still matter.

## Start here

From a source checkout root, inspect the commands and your environment:

```sh
node bin/project-state.js help
node bin/project-state.js doctor
```

You do not need to run the full test suite to use the tool.

## Try a disposable project

From the source checkout root:

```sh
npm run demo
```

The demo creates a one-time synthetic Git project under the OS temporary directory. It saves a fake `.env`, compares a change, previews and restores it, executes the exact rollback command printed by the CLI, and checks bytes through A → B → A → B. It does not edit the current project and does not test application health or real project data. Failed runs retain the marked demo directory for inspection.

The demo script is also included in the local tarball. From an installed package directory, run `npm run demo`; the demo still creates a separate temporary project. The CLI itself can be run from the installation prefix as shown below.

## Save, compare, preview, restore

Examples below assume the current directory is the project root. Replace the tool path with your source checkout or installation prefix. The configuration file must already be excluded from Git. Run `git check-ignore -- .env` first and stop if it prints no matching rule; add and commit an appropriate ignore rule before creating sensitive local values. The commands do not edit the configuration for you.

PowerShell, using a source checkout:

```powershell
$toolRoot = 'C:\path\to\project-state' # replace with the source checkout
$cli = Join-Path $toolRoot 'bin\project-state.js'
git check-ignore -- .env
node $cli doctor
node $cli snapshot before-config-change
# Change your local configuration with your normal editor.
node $cli compare before-config-change
node $cli restore before-config-change --only config --dry-run
# Review the current plan, then explicitly authorize the write:
node $cli restore before-config-change --only config --yes
```

Bash, using a source checkout:

```sh
TOOL_ROOT='/path/to/project-state' # replace with the source checkout
CLI="$TOOL_ROOT/bin/project-state.js"
git check-ignore -- .env
node "$CLI" doctor
node "$CLI" snapshot before-config-change
# Change your local configuration with your normal editor.
node "$CLI" compare before-config-change
node "$CLI" restore before-config-change --only config --dry-run
# Review the current plan, then explicitly authorize the write:
node "$CLI" restore before-config-change --only config --yes
```

For an installed local tarball, set the CLI path to `tool-prefix/node_modules/project-state-snapshot/bin/project-state.js` (with the platform's path separators). Install the exact tarball into a separate prefix; this candidate is not available from the npm registry. Restored file bytes are verified, but the application is not restarted or health-tested. If restore prints an exact rollback command, run that unchanged from the same project root; do not rewrite it.

## If an operation refuses or stops

Use `project-state list` to inspect available snapshots, then `compare` and `restore --dry-run` to review supported state. For an interrupted transaction, use the operation ID printed by the CLI with `recover <operationId> --inspect`. Preserve the lock, journal, pins, and referenced snapshot data if inspection refuses or reports ambiguity. Do not delete a database or sidecar, remove a lock, reset Git, stash user changes, or use `--force` to work around a refusal.

## Boundaries and further reading

- Snapshots record selected files and metadata. A partial snapshot reports skipped layers; it does not imply those layers can be restored.
- Git restore requires a supported clean state and complete protection for overwritten targets. `--force` does not bypass uncertainty. Branch refs are not moved.
- `--only config,deps,runtime` is a constrained file restore; it does not restore Git, database rows, Docker, running services, or machine state.
- SQLite rows are captured only with explicit `snapshot --with-seed` and a real SQLite CLI. Full backups are private local plaintext. Restore creates a missing database target only; existing targets and sidecars are refused. Schema-only capture does not restore rows. SQL is never executed.
- Hashes detect content changes; they do not authenticate a snapshot author. Successful file verification is not application health.

See the [capability matrix](docs/CAPABILITY-MATRIX.md), [contract](docs/CONTRACTS.md), [known limitations](docs/KNOWN-LIMITATIONS.md), and [contribution/testing guide](CONTRIBUTING.md).
