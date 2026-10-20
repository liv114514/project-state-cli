# Contributing

## Requirements

- Node.js 22 or 24.
- Git for the Git integration tests.
- A real `sqlite3` CLI on `PATH`; database gates must not silently skip it.
- No npm install is required for the zero-runtime-dependency test suite. This repository intentionally has no lockfile, so do not run `npm ci`.

## Local checks

```sh
npm run check:version
REQUIRE_SQLITE_TESTS=1 npm test
npm run pack:check
```

PowerShell:

```powershell
npm run check:version
$env:REQUIRE_SQLITE_TESTS = '1'
npm test
Remove-Item Env:REQUIRE_SQLITE_TESTS
npm run pack:check
```

Record Node, npm, Git, SQLite, OS, command, working directory, exit code, and test pass/fail/skip counts when preparing acceptance evidence. `REQUIRE_SQLITE_TESTS=1` must fail when the real CLI is missing.

## Test and failure evidence

- Tests use disposable directories and synthetic values only. Do not point fixtures at real projects, credentials, databases or `.project-state` state.
- Assert file bytes, Git HEAD/index/refs, database rows/schema/integrity, snapshot safety points, and refusal-side non-mutation where applicable. An exit code alone is not enough.
- Keep correct security assertions. Do not delete tests, add unconditional returns, broaden skips or alter totals to make a run green.
- Label real CLI, fault injection, process termination, mechanism-only experiments and unverified platform behavior separately. Process termination is not power-loss testing.
- Do not commit raw local logs, absolute paths, databases, private state, npm caches or install prefixes. Summarize only the minimum evidence needed for review.

## Changes

Update the contract before changing serialized fields or restore semantics. Keep `package.json` and `lib/utils.js` versions aligned, run the package allowlist checker, and update bilingual docs when support boundaries change. Workflow actions are pinned by full commit SHA; verify any proposed pin against the action's official release repository.
