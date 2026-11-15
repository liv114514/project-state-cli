"""Point-in-time restore location checks; this does not authorize a write."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from project_state.contracts.capabilities import CROSS_VOLUME_MESSAGE
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import require_same_volume


@dataclass(frozen=True, slots=True)
class RestoreLocationCheck:
    same_volume: bool
    target_location: str = 'project'
    private_stage_location: str = 'private-state'
    private_backup_location: str = 'private-state'
    atomic_rename_required: bool = True


def check_restore_location(target: Path, private_state: Path) -> RestoreLocationCheck:
    """Re-probe both paths; do not cache this observation across writes."""
    try:
        require_same_volume(target, private_state)
    except ProjectStateError as exc:
        if exc.code == "ECROSS_VOLUME_UNSUPPORTED":
            raise ProjectStateError(exc.code, CROSS_VOLUME_MESSAGE, exc.exit_code) from exc
        raise
    return RestoreLocationCheck(same_volume=True)
