"""Small ports used to keep capture and recovery implementations independent."""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .results import SafetyPointReference


class OperationGatePort(Protocol):
    """Read-only gate. It never repairs or resolves an operation."""

    def assert_no_unresolved(self, project_root: Path) -> None: ...


class SafetyPointPort(Protocol):
    """Create/verify a safety generation while the caller-owned project lock is held."""

    def create_safety_point(self, project_root: Path, name: str, lock_handle: object) -> SafetyPointReference: ...
