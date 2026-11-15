"""Machine-readable internal capability facts, separate from write authority."""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from .results import Diagnostic

CROSS_VOLUME_MESSAGE = (
    "This restore requires the project and private state directory to be on the same filesystem volume. "
    "Preserve the existing state and consult the location guidance; automatic relocation is not supported."
)


class CapabilityState(StrEnum):
    SUPPORTED = "supported"
    BLOCKED = "blocked"
    NOT_APPLICABLE = "not-applicable"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class Capability:
    name: str
    state: CapabilityState
    constraints: tuple[str, ...] = ()
    diagnostic: Diagnostic | None = None
