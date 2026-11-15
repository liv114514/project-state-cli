from __future__ import annotations


class ProjectStateError(Exception):
    """A sanitized, user-facing failure with stable CLI classification."""

    def __init__(self, code: str, message: str, exit_code: int = 2):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class UnsupportedError(ProjectStateError):
    def __init__(self, message: str):
        super().__init__("EUNSUPPORTED", message, 2)
