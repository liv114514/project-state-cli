# project-state

**Record selected local project state, compare drift, and restore a deliberately limited subset.**

**简体中文简介：** project-state 是一款本地命令行工具，用于记录选定的项目状态、比较变化，并在通过安全校验时恢复明确支持的工件。它不是完整备份或应用健康检查工具，也不会自动重启应用。详见[中文版文档](README.zh-CN.md)。

`project-state` is a local Node.js command-line tool. A snapshot is an observation of selected files and metadata; it is not a full machine backup, application health check, or general workspace recovery system.

## Requirements

- Node.js 22 or newer.
- Git for Git observations and the supported Git restore path.
- A real `sqlite3` CLI for SQLite collection and strict database tests.
- No runtime npm dependencies. Git, SQLite, filesystem behavior, and platform support still matter.

This repository starts with the private local candidate `1.4.0-rc.9`. It has not been published to npm and is not a release.

## Run from a source checkout

```sh
node bin/project-state.js help
npm run check:version
REQUIRE_SQLITE_TESTS=1 npm test
```

PowerShell strict test invocation:

```powershell
$env:REQUIRE_SQLITE_TESTS = '1'
npm test
Remove-Item Env:REQUIRE_SQLITE_TESTS
```

The strict suite requires `sqlite3` on the current process `PATH`; if it is missing, the database tests fail instead of silently skipping.

## Install an exact local tarball

This pre-release is not available from the npm registry. From a checkout, build a local tarball with `npm pack`, then install that exact file into a separate prefix:

```sh
npm pack
npm install --prefix ./tool-prefix --ignore-scripts --no-audit --no-fund ./project-state-snapshot-1.4.0-rc.9.tgz
node ./tool-prefix/node_modules/project-state-snapshot/bin/project-state.js help
```

Keep the prefix outside a protected project if you do not want its package files changed. Do not use a registry install command for this unpublished version.

## One-time configuration example

Use a disposable Git project and a clearly fictional value. Commit the ignore rule before creating the local config file:

```sh
mkdir project-state-demo && cd project-state-demo
git init
git config user.name Demo
git config user.email demo@example.invalid
printf '.env\n.project-state/\n' > .gitignore
git add .gitignore && git commit -m "Add local-state ignore rules"
printf 'APP_MODE=example-only\n' > .env
node /path/to/project-state/bin/project-state.js snapshot demo-before
printf 'APP_MODE=changed-example-only\n' > .env
node /path/to/project-state/bin/project-state.js compare demo-before
node /path/to/project-state/bin/project-state.js restore demo-before --only config --dry-run
node /path/to/project-state/bin/project-state.js restore demo-before --only config --yes
```

The value is synthetic and is never committed. Local private artifacts are plaintext under `.project-state/secrets/`; protect the entire `.project-state` directory. After a verified restore, inspect the target and application yourself. The tool does not restart the application. If the CLI prints a rollback command, copy and run that exact command from the same project root; rollback is narrowly scoped and refuses unrelated changes.

## Supported boundaries

- Restore accepts validated snapshot schema v2 artifacts. Schema v1 is diagnostic-only; unknown future formats are refused.
- Git restore is limited to supported ordinary repositories with a clean index and worktree and complete protection for every overwritten target. Uncommitted source, staged changes, and untracked files are not general backup objects. `--force` cannot bypass an unsafe or uncertain state. Branch refs are not moved.
- `--only config,deps,runtime` is a constrained file-layer restore; it does not switch Git or restore databases/Docker state.
- SQLite row data is collected only with explicit `snapshot --with-seed` and a real SQLite CLI. If a supported database is found but its backup fails, `--with-seed` exits unsuccessfully and does not publish a generation; ordinary snapshots may save with the database layer explicitly marked skipped. Full backups are private. Restore can create a missing target only; an existing database or sidecar is refused. Schema-only observations do not restore rows. SQL text is recorded only and never executed.
- Docker is record-only. Dependencies are observed, not installed or switched. No command starts an application or restores running containers, services, volumes, or machine state.
- Private storage is local plaintext. Hashes detect changes but do not authenticate a snapshot author.

See [capability matrix](docs/CAPABILITY-MATRIX.md), [contract](docs/CONTRACTS.md), and [known limitations](docs/KNOWN-LIMITATIONS.md).
