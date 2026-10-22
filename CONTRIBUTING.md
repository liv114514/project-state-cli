# Development and testing

## Run from a source checkout

Node.js 22 or newer and Git are required. No install step is needed for the CLI itself.

```sh
node bin/project-state.js help
node bin/project-state.js help restore
```

Run the synthetic end-to-end demo with `npm run demo`. It creates its own temporary Git project and synthetic `.env`; it does not use the current project as test data. To retain the demo directory for inspection, use `npm run demo -- --keep` and remove it manually only after confirming its printed path and ownership marker.

Run unit and integration tests with `npm test`. For the strict SQLite suite, put a real `sqlite3` executable on the test process `PATH` and set `REQUIRE_SQLITE_TESTS=1`. The install verifier is `npm run test:install`; it packs the exact package, installs it offline in a temporary prefix, runs the packaged demo, and checks file and SQLite restore/rollback behavior. `npm run pack:check` checks the npm file allowlist.

The project reports explicit skips when a host capability is unavailable. Do not turn a skip into a pass or treat the demo as application health or user-value evidence.

## Scope and reports

The tool records selected local project state and restores only validated supported artifacts. Read [the contract](docs/CONTRACTS.md), [capability matrix](docs/CAPABILITY-MATRIX.md), and [known limitations](docs/KNOWN-LIMITATIONS.md) before changing public behavior. Product behavior or contract-field changes require a contract revision; help and documentation changes alone do not.
