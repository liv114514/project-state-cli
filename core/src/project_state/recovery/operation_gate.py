"""Recovery operation gate across both validated journal families."""
from pathlib import Path
import re
import stat
from typing import Any, Callable
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path
from project_state.foundation.state_paths import state_dir
from project_state.recovery.config_journal import load_records
from project_state.recovery.sqlite_journal import _load_records as load_sqlite_records

_OP_ID = re.compile(r"^[a-f0-9]{32}$")

def assert_no_unresolved_operations(root: Path, *, database_reader: Callable[[Path, str], list[dict[str, Any]]] = load_sqlite_records) -> None:
    """Fail closed before starting a new write while an earlier restore is unresolved.

    A process lock only serializes live writers; it does not establish that a
    previous journal reached a terminal state. Recovery is the only operation
    allowed to advance a nonterminal journal.
    """
    base = state_dir(root) / "operations"
    try:
        base_stat = base.lstat()
    except FileNotFoundError:
        return
    assert_plain_path(base)
    if not stat.S_ISDIR(base_stat.st_mode):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "operation inventory is not a plain directory; preserve it", 2)
    for directory in base.iterdir():
        assert_plain_path(directory)
        if not directory.is_dir() or not _OP_ID.fullmatch(directory.name):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "operation inventory contains an unrecognized entry; preserve it", 2)
        entries = list(directory.iterdir())
        if any(item.name.startswith("db-record-") for item in entries):
            if database_reader is None:
                raise ProjectStateError("EOPERATION_UNCERTAIN", "SQLite operation requires the recovery journal reader; preserve it", 2)
            records = database_reader(root, directory.name)
        else:
            records = load_records(root, directory.name)
        latest = records[-1]
        if latest.get("status") not in {"completed", "rolled-back", "cancelled"}:
            if latest.get("ownerBinding") is None:
                raise ProjectStateError(
                    "ERECOVERY_LEGACY",
                    "an earlier restore has no durable resolver owner binding; preserve it and use its originating runtime to inspect or resolve it",
                    2,
                )
            raise ProjectStateError(
                "ERECOVERY_REQUIRED",
                "an earlier restore operation is unresolved; inspect and recover its operation ID before starting another write",
                2,
            )



class RecoveryOperationGate:
    def assert_no_unresolved(self, project_root: Path) -> None:
        assert_no_unresolved_operations(project_root)
