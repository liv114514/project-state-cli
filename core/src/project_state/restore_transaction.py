"""Compatibility facade for configuration restore."""
from project_state.recovery import config as _implementation
from project_state.application import apply_config_restore as apply_config_restore
from project_state.application import continue_operation as continue_operation
from project_state.application import rollback_operation as rollback_operation
from project_state.application import recover as recover
from project_state.application import inspect_operation as inspect_operation

def __getattr__(name):
    return getattr(_implementation, name)

def __dir__():
    return sorted(set(globals()) | set(dir(_implementation)))
