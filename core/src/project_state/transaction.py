"""Compatibility facade for journal primitives and the composed write gate."""
from project_state.recovery import config_journal as _implementation
from project_state.recovery.operation_gate import assert_no_unresolved_operations


def __getattr__(name):
    return getattr(_implementation, name)


def __dir__():
    return sorted(set(globals()) | set(dir(_implementation)))
