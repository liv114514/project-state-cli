from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from project_state.state_paths import ensure_state_dir, state_dir


def _test_base() -> Path:
    """Create fixtures under an explicit runner root or the system temp root."""
    configured = os.environ.get("PROJECT_STATE_TEST_ROOT")
    base = Path(configured) if configured else Path(__file__).resolve().parents[4] / "_pt"
    if not base.is_absolute():
        raise ValueError("PROJECT_STATE_TEST_ROOT must be absolute")
    base.mkdir(parents=True, exist_ok=True)
    return base


class _ProjectTemporaryDirectory:
    """Project fixture and its isolated user-state home on the same volume."""

    def __init__(self) -> None:
        self._container = tempfile.TemporaryDirectory(dir=_test_base(), prefix="t")
        container = Path(self._container.name)
        try:
            identity = container.lstat()
            if container.is_symlink() or not identity.st_ino or not container.is_dir():
                raise RuntimeError("test fixture directory identity is unavailable; preserved")
            self._identity = (identity.st_dev, identity.st_ino)
            self.name = os.fspath(container / "p")
            Path(self.name).mkdir()
            state_home = container / "s"
            state_home.mkdir()
        except BaseException:
            # Initialization never established that the current path is still
            # ours. Preserve it, even if that leaves an incomplete fixture.
            self._container._finalizer.detach()
            raise
        self._env_name = "LOCALAPPDATA" if os.name == "nt" else "XDG_STATE_HOME"
        self._previous = os.environ.get(self._env_name)
        os.environ[self._env_name] = os.fspath(state_home)
        self._cleaned = False

    def __enter__(self) -> str:
        return self.name

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.cleanup()

    def cleanup(self) -> None:
        if self._cleaned:
            return
        if self._previous is None:
            os.environ.pop(self._env_name, None)
        else:
            os.environ[self._env_name] = self._previous
        self._cleaned = True
        # Never recursively remove a replacement at the originally created path.
        path = Path(self._container.name)
        self._container._finalizer.detach()
        observed = path.lstat()
        if path.is_symlink() or (observed.st_dev, observed.st_ino) != self._identity or not observed.st_ino:
            raise RuntimeError("test fixture directory identity changed; preserved")
        self._container.cleanup()


def temporary_directory() -> _ProjectTemporaryDirectory:
    """Return an isolated fixture; environment changes last until cleanup."""
    return _ProjectTemporaryDirectory()
