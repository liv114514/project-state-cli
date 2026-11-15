from __future__ import annotations

"""Read-only SQLite metadata shared by capture and recovery."""

import hashlib
import re
import sqlite3

SQLITE_NAME_PATTERN = re.compile(r"^(?!con(?:\.|$)|prn(?:\.|$)|aux(?:\.|$)|nul(?:\.|$)|com[1-9](?:\.|$)|lpt[1-9](?:\.|$))[^.].*\.(?:db|sqlite|sqlite3)$", re.I)

def schema_and_counts(connection: sqlite3.Connection) -> tuple[list[str], int, str]:
    rows = connection.execute(
        "SELECT type, name, sql FROM sqlite_master "
        "WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' "
        "ORDER BY type, name"
    ).fetchall()
    schema_material = "\n".join("\0".join(str(value or "") for value in row) for row in rows).encode("utf-8")
    table_names = [row[1] for row in rows if row[0] == "table"]
    counts: list[int] = []
    for name in table_names:
        quoted = '"' + name.replace('"', '""') + '"'
        counts.append(int(connection.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]))
    return table_names, sum(counts), hashlib.sha256(schema_material).hexdigest()

