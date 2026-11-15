"""Synthetic SQLite helpers for the installed-entry lifecycle test."""
from __future__ import annotations
import json, os, sqlite3, subprocess, sys
from pathlib import Path

if len(sys.argv) >= 3 and sys.argv[1] == "verify-only":
    path = Path(sys.argv[2])
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        schema = connection.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").fetchall()
        rows = connection.execute("SELECT label, nullable, payload FROM markers").fetchall()
        valid = integrity == "ok" and schema == [
            ("index", "markers_label_idx", "CREATE INDEX markers_label_idx ON markers(label)"),
            ("table", "markers", "CREATE TABLE markers (id INTEGER PRIMARY KEY, label TEXT, nullable TEXT, payload BLOB)")
        ] and rows == [("已提交🌏", None, bytes((0, 16, 255)))]
        print(json.dumps({"integrityCheck": integrity, "schema": schema, "rows": [[row[0], row[1], row[2].hex()] for row in rows], "valid": valid}, ensure_ascii=True))
        raise SystemExit(0 if valid else 1)
    finally:
        connection.close()

pwsh_path, db_path, shim_path, project_dir, state_home, fake_python_path, fake_python_home, fake_user_base = sys.argv[1:]
db = Path(db_path)
project = Path(project_dir)
connection = sqlite3.connect(db)
try:
    mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE IF NOT EXISTS markers (id INTEGER PRIMARY KEY, label TEXT, nullable TEXT, payload BLOB)")
    connection.execute("CREATE INDEX IF NOT EXISTS markers_label_idx ON markers(label)")
    connection.execute("DELETE FROM markers")
    connection.execute("INSERT INTO markers(label, nullable, payload) VALUES (?, ?, ?)", ("已提交🌏", None, bytes((0, 16, 255))))
    connection.commit()
    wal_path = Path(str(db) + "-wal")
    wal_before = wal_path.exists() and wal_path.stat().st_size > 0
    shim_runner = str(Path(__file__).with_name("invoke-installed-shim.ps1"))
    environment = os.environ.copy()
    environment["LOCALAPPDATA"] = state_home
    environment["PYTHONPATH"] = fake_python_path
    environment["PYTHONHOME"] = fake_python_home
    environment["PYTHONUSERBASE"] = fake_user_base
    environment["PYTHONNOUSERSITE"] = "0"
    environment["PYTHONUTF8"] = "0"
    process = subprocess.run([pwsh_path, "-NoProfile", "-File", shim_runner, "-Shim", shim_path, "snapshot", "sqlite-a", "--with-seed"], cwd=project, env=environment, text=True, capture_output=True)
    row = connection.execute("SELECT label, nullable, payload FROM markers").fetchone()
    print(json.dumps({"journalMode": mode, "walPresentBeforeSnapshot": wal_before, "snapshotExit": process.returncode, "stdout": process.stdout, "stderr": process.stderr, "walPresentAfterSnapshot": wal_path.exists(), "writerStillReadCommittedRow": row == ("已提交🌏", None, bytes((0, 16, 255)))}, ensure_ascii=False))
    if process.returncode != 0 or mode.lower() != "wal" or not wal_before or row != ("已提交🌏", None, bytes((0, 16, 255))):
        raise SystemExit(1)
finally:
    connection.close()
