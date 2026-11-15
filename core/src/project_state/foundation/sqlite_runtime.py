from __future__ import annotations

"""Minimum SQLite engine version required for safe online-WAL backup use."""

import sqlite3

from project_state.contracts.errors import ProjectStateError

MIN_SQLITE_VERSION = (3, 51, 3)


def sqlite_runtime_status() -> dict[str, object]:
    current = tuple(sqlite3.sqlite_version_info)
    return {"version": sqlite3.sqlite_version, "versionInfo": current,
            "minimum": MIN_SQLITE_VERSION, "supported": current >= MIN_SQLITE_VERSION}


def require_safe_sqlite() -> None:
    status = sqlite_runtime_status()
    if not status["supported"]:
        raise ProjectStateError(
            "ESQLITE_RUNTIME",
            f"SQLite online backup requires engine {'.'.join(map(str, MIN_SQLITE_VERSION))} or newer because of a fixed WAL-reset defect; current engine is {status['version']}; no database operation was started",
            2,
        )
