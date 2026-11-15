"""Compatibility facade for snapshot capture; use application.create_snapshot."""
from project_state.capture import snapshot as _implementation
from project_state.application import create_snapshot as create_snapshot

def __getattr__(name):
    return getattr(_implementation, name)

def __dir__():
    return sorted(set(globals()) | set(dir(_implementation)))
