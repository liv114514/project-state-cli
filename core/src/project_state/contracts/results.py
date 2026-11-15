"""Versioned-in-process references; these do not change external JSON schemas."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    message: str
    severity: Literal["info", "warning", "error"] = "error"
    object_kind: str | None = None
    next_step: str | None = None


@dataclass(frozen=True, slots=True)
class SnapshotReference:
    name: str
    generation: str
    schema_version: int
    state: str


@dataclass(frozen=True, slots=True)
class ArtifactReference:
    artifact_id: str
    layer: str
    kind: str
    target: str | None
    privacy: Literal["public", "private"]
    restore_class: str
    size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class SafetyPointReference:
    name: str
    generation: str
    verified: bool
    protected_artifacts: tuple[ArtifactReference, ...]


class RestorePlan(TypedDict):
    resultSchemaVersion: int
    command: str
    mode: str
    snapshot: str
    generation: str
    selectedLayers: list[str]
    targets: list[dict[str, object]]
    git: dict[str, object]
    businessWrites: int
    safetyPointCreated: bool
    nextStep: str


class OperationInspection(TypedDict):
    resultSchemaVersion: int
    operationId: str
    status: str
    phase: str
    recoveryActions: list[str]


class VerificationResult(TypedDict):
    verified: bool
    objectKind: str
    identity: NotRequired[str]
    size: NotRequired[int]
    sha256: NotRequired[str]
    diagnostic: NotRequired[Diagnostic]
