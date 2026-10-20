# Test fixtures

The database tests (`test/db.test.js`) need a real SQLite CLI. The tests use
`sqlite3` from `PATH`; this repository does not bundle an executable.

- **CI** provisions the sqlite3 CLI on its runners (see
  `.github/workflows/ci.yml`).
- **Locally**, install SQLite from its official distribution or your trusted
  package manager, then ensure `sqlite3` is on `PATH`.

Without the CLI, an ordinary local run reports database integration tests as
skipped. The required acceptance command sets `REQUIRE_SQLITE_TESTS=1`; in that
mode a missing CLI fails the database gate and cannot produce a passing result.
