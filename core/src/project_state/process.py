"""Compatibility import path; implementation lives in project_state.foundation.process."""
import importlib as _importlib
import sys as _sys
_impl = _importlib.import_module("project_state.foundation.process")
_sys.modules[__name__] = _impl
