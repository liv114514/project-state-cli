"""Compatibility import path; implementation lives in project_state.foundation.state_paths."""
import importlib as _importlib
import sys as _sys
_impl = _importlib.import_module("project_state.foundation.state_paths")
_sys.modules[__name__] = _impl
