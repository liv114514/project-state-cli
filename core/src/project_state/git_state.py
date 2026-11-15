"""Compatibility import path; implementation lives in project_state.foundation.git_state."""
import importlib as _importlib
import sys as _sys
_impl = _importlib.import_module("project_state.foundation.git_state")
_sys.modules[__name__] = _impl
