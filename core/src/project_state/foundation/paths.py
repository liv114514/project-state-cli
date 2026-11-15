from __future__ import annotations

import os
import re
import stat
import ctypes
from pathlib import Path

from project_state.contracts.errors import ProjectStateError

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_ID = re.compile(r"^[a-f0-9]{32}$")
_AUTO_NAME = re.compile(r"^auto-\d{8}-\d{6}(?:-\d+)?$")
_HOOK_NAME = re.compile(r"^hook-\d{8}-\d{6}(?:-\d+)?$")
_RESERVED = {".git", ".project-state", ".hg", ".svn", ".codex", ".agents", ".workbuddy"}
_DEVICE = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
_WINDOWS_MAX_PATH_UNITS = 260


def validate_name(name: str) -> str:
    if not isinstance(name, str) or not _NAME.fullmatch(name) or name.lower().startswith(("auto-", "hook-")):
        raise ProjectStateError("EUNSAFE_PATH", "invalid or reserved snapshot name", 1)
    return name


def validate_snapshot_name(name: str) -> str:
    """Validate a stored snapshot name, including managed auto/hook names.

    User-created names remain restricted by :func:`validate_name`; this wider
    validator is only for reading or resolving already-published generations.
    """
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise ProjectStateError("EUNSAFE_PATH", "invalid snapshot name", 1)
    if name.lower().startswith(("auto-", "hook-")):
        if _AUTO_NAME.fullmatch(name) or _HOOK_NAME.fullmatch(name):
            return name
        raise ProjectStateError("EUNSAFE_PATH", "invalid managed snapshot name", 1)
    return name


def validate_generation(value: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ProjectStateError("EMANIFEST_INVALID", "snapshot generation identity is invalid", 1)
    return value


def validate_relative(value: object) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        raise ProjectStateError("EUNSAFE_PATH", "artifact path is not a safe relative path", 1)
    if any(ord(ch) < 32 or ord(ch) == 127 or ch == ":" for ch in value):
        raise ProjectStateError("EUNSAFE_PATH", "artifact path contains a forbidden character", 1)
    parts = value.split("/")
    if any(not p or p in {".", ".."} or p.endswith((".", " ")) or any(c in p for c in '<>"|?*') for p in parts):
        raise ProjectStateError("EUNSAFE_PATH", "artifact path contains an unsafe component", 1)
    if any(p.lower() in _RESERVED or _DEVICE.match(p) for p in parts):
        raise ProjectStateError("EUNSAFE_PATH", "artifact path targets a reserved component", 1)
    return value


def is_reparse_point(st: os.stat_result) -> bool:
    attrs = getattr(st, "st_file_attributes", 0)
    return stat.S_ISLNK(st.st_mode) or bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def assert_plain_path(path: Path, *, allow_missing: bool = False, hardlinks: bool = False) -> None:
    """Reject symlinks/reparse points component-by-component and hardlinked files."""
    absolute = path.absolute()
    chain = list(reversed((absolute, *absolute.parents)))
    for index, item in enumerate(chain):
        try:
            st = item.lstat()
        except FileNotFoundError:
            if allow_missing:
                return
            raise ProjectStateError("EINVENTORY_UNREADABLE", "required storage path is missing")
        except OSError as exc:
            raise ProjectStateError("EINVENTORY_UNREADABLE", "storage path cannot be inspected") from exc
        if is_reparse_point(st):
            raise ProjectStateError("EUNSAFE_PATH", "links and reparse points are unsupported in snapshot storage", 1)
        if index < len(chain) - 1 and not stat.S_ISDIR(st.st_mode):
            raise ProjectStateError("EUNSAFE_PATH", "storage path ancestor is not a directory", 1)
        if hardlinks and stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
            raise ProjectStateError("EUNSAFE_PATH", "hardlinked snapshot files are unsupported", 1)


def require_windows_path_budget(paths: list[Path]) -> None:
    """Fail before writes when derived paths exceed the tested Win32 limit.

    The installed console launcher is not certified as long-path-aware. Use
    UTF-16 code units (including the terminating NUL) rather than Python code
    points, and never try to move the project automatically.
    """
    if os.name != "nt":
        return
    for path in paths:
        absolute = os.path.abspath(os.fspath(path))
        units = len(absolute.encode("utf-16-le", errors="strict")) // 2
        if units >= _WINDOWS_MAX_PATH_UNITS:
            raise ProjectStateError(
                "EWINDOWS_PATH_LIMIT",
                "required project-state paths exceed the supported Windows path limit; retry only from a shorter verified project path; no data was moved",
                2,
            )


def _existing_directory(path: Path) -> Path:
    candidate = path.absolute()
    if candidate.exists():
        return candidate if candidate.is_dir() else candidate.parent
    for parent in candidate.parents:
        if parent.exists():
            return parent
    raise ProjectStateError("EVOLUME_IDENTITY", "restore volume identity could not be verified; no data was moved", 2)


def volume_identity(path: Path) -> str:
    """Return a stable filesystem volume identity for a path or its parent.

    Windows uses the volume GUID returned by the OS, so mount points and drive
    aliases are compared by the volume they actually address. Other platforms
    use the device identity of the nearest existing directory. Unverifiable
    paths fail closed; callers must not infer identity from drive letters.
    """
    directory = _existing_directory(path)
    assert_plain_path(directory)
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Always use one identity source. Mixing a volume-GUID fast path with
        # an NT-device fallback can make the same volume compare unequal when
        # only one of the two path probes falls back.
        create_file = kernel32.CreateFileW
        create_file.argtypes = [ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_uint,
                                ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]
        create_file.restype = ctypes.c_void_p
        handle = create_file(str(directory), 0, 0x1 | 0x2 | 0x4, None, 3, 0x02000000, None)
        invalid_handle = ctypes.c_void_p(-1).value
        if handle in (None, invalid_handle):
            raise ProjectStateError("EVOLUME_IDENTITY", "restore volume identity could not be verified; no data was moved", 2)
        try:
            get_final = kernel32.GetFinalPathNameByHandleW
            get_final.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_uint]
            get_final.restype = ctypes.c_uint
            final = ctypes.create_unicode_buffer(32768)
            length = get_final(handle, final, len(final), 0x2)  # VOLUME_NAME_NT
            if length == 0 or length >= len(final):
                raise ProjectStateError("EVOLUME_IDENTITY", "restore volume identity could not be verified; no data was moved", 2)
        finally:
            kernel32.CloseHandle(handle)
        components = final.value.replace("/", "\\").split("\\")
        if len(components) < 3 or components[1].casefold() != "device" or not components[2]:
            raise ProjectStateError("EVOLUME_IDENTITY", "restore volume identity could not be verified; no data was moved", 2)
        return f"windows-nt-volume:{components[1].casefold()}\\{components[2].casefold()}"
    try:
        return f"device:{directory.stat().st_dev}"
    except OSError as exc:
        raise ProjectStateError("EVOLUME_IDENTITY", "restore volume identity could not be verified; no data was moved", 2) from exc


def require_same_volume(first: Path, second: Path) -> None:
    if volume_identity(first) != volume_identity(second):
        raise ProjectStateError(
            "ECROSS_VOLUME_UNSUPPORTED",
            "this restore requires the project and private state directory to be on the same filesystem volume; no data was moved",
            2,
        )


def project_root(value: str | os.PathLike[str]) -> Path:
    path = Path(value).absolute()
    assert_plain_path(path)
    try:
        st = path.lstat()
    except OSError as exc:
        raise ProjectStateError("EUNSAFE_PATH", "project directory cannot be inspected", 1) from exc
    if not stat.S_ISDIR(st.st_mode):
        raise ProjectStateError("EUNSAFE_PATH", "project root must be a canonical real directory", 1)
    return path
