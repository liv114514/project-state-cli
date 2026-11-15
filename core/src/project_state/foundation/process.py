"""Bounded, project-excluding execution of trusted native tools.

This is an internal primitive for later Git/collector migration. It does not
make any write command available by itself.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from pathlib import Path
import stat

from project_state.foundation.paths import project_root

_WINDOWS_SCRIPT_SUFFIXES = {".cmd", ".bat", ".ps1"}
_COMMAND_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$")


def _inside(path: Path, root: Path) -> bool:
    try:
        common = os.path.commonpath((str(path), str(root)))
        return os.path.normcase(common) == os.path.normcase(str(root))
    except (ValueError, OSError):
        return False


def resolve_trusted_binary(command: str, root_value: str | os.PathLike[str], *, env: dict[str, str] | None = None) -> Path | None:
    """Resolve a simple executable name from PATH, excluding the project tree.

    Script shims are deliberately refused on Windows. Callers that need one
    must add a separately reviewed native launcher rather than invoking a
    shell with user-controlled arguments.
    """
    if not isinstance(command, str) or not _COMMAND_NAME.fullmatch(command):
        return None
    # project_root already walks the absolute component chain with lstat.
    # Avoid realpath here: on restricted Windows hosts it can fail with EPERM
    # even when every component was successfully inspected without following
    # reparse points.
    root = project_root(root_value)
    search_env = os.environ if env is None else env
    path_value = search_env.get("PATH", "")
    if not isinstance(path_value, str):
        return None
    suffixes = [""]
    if os.name == "nt":
        raw = search_env.get("PATHEXT", ".COM;.EXE;.BAT;.CMD")
        if not isinstance(raw, str):
            raw = ".COM;.EXE;.BAT;.CMD"
        suffixes = [s.lower() for s in raw.split(";") if s]
        if Path(command).suffix:
            suffixes = [""]
    for entry in path_value.split(os.pathsep):
        if not entry:
            continue
        directory = Path(entry).expanduser()
        if not directory.is_absolute():
            directory = root / directory
        directory = Path(os.path.abspath(directory))
        try:
            directory_stat = directory.stat()
            if not stat.S_ISDIR(directory_stat.st_mode):
                continue
            from project_state.foundation.paths import assert_plain_path
            assert_plain_path(directory)
        except OSError:
            continue
        except Exception:
            continue
        if _inside(directory, root):
            continue
        for suffix in suffixes:
            candidate = directory / (command if not suffix else command + suffix)
            try:
                candidate_stat = candidate.lstat()
                if not stat.S_ISREG(candidate_stat.st_mode):
                    continue
                from project_state.foundation.paths import assert_plain_path
                assert_plain_path(candidate)
                resolved = Path(os.path.abspath(candidate))
                if _inside(resolved, root):
                    continue
                if os.name == "nt" and candidate.suffix.lower() in _WINDOWS_SCRIPT_SUFFIXES:
                    continue
                if os.name != "nt" and not os.access(resolved, os.X_OK):
                    continue
                return resolved
            except Exception:
                continue
    return None


def run_trusted(
    command: str,
    args: list[str],
    *,
    cwd: str | os.PathLike[str],
    timeout: float = 30.0,
    max_output: int = 10 * 1024 * 1024,
    env: dict[str, str] | None = None,
) -> dict:
    """Run a trusted native executable without a shell and with bounded output."""
    if not isinstance(args, list) or any(not isinstance(arg, str) or "\0" in arg for arg in args):
        raise ValueError("arguments must be NUL-free strings")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 300 or not isinstance(max_output, int) or not 1 <= max_output <= 10 * 1024 * 1024:
        raise ValueError("timeout must be at most 300 seconds and output limit at most 10 MiB")
    if env is not None and not isinstance(env, dict):
        raise ValueError("child environment must be a string mapping")
    root = project_root(cwd)
    executable = resolve_trusted_binary(command, root, env=env)
    if executable is None:
        return {"ok": False, "code": "ENOENT", "started": False, "exitCode": None, "signal": None,
                "timedOut": False, "outputTruncated": False, "complete": True,
                "stdout": "", "stderr": "", "stdoutBytes": 0, "stderrBytes": 0,
                "message": f'trusted native executable for "{command}" not found outside the project'}

    child_env = dict(os.environ if env is None else env)
    for key, value in child_env.items():
        if not isinstance(key, str) or not key or "=" in key or "\0" in key or not isinstance(value, str) or "\0" in value:
            raise ValueError("child environment contains an invalid entry")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        process = subprocess.Popen(
            [str(executable), *args], cwd=root, env=child_env, shell=False,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=creationflags,
        )
    except OSError:
        return {"ok": False, "code": "ESPAWN", "started": False, "spawnError": "OSError",
                "exitCode": None, "signal": None, "timedOut": False, "outputTruncated": False,
                "complete": True, "stdout": "", "stderr": "", "stdoutBytes": 0, "stderrBytes": 0,
                "message": f'trusted executable for "{command}" could not be started'}

    captured = {"stdout": bytearray(), "stderr": bytearray()}
    counts = {"stdout": 0, "stderr": 0}
    overflow = threading.Event()
    guard = threading.Lock()

    def drain(stream, label: str) -> None:
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    return
                with guard:
                    counts[label] += len(chunk)
                    remaining = max_output - len(captured["stdout"]) - len(captured["stderr"])
                    if remaining > 0:
                        captured[label].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        overflow.set()
        finally:
            stream.close()

    readers = [threading.Thread(target=drain, args=(process.stdout, "stdout"), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, "stderr"), daemon=True)]
    for reader in readers:
        reader.start()
    start = time.monotonic()
    timed_out = False
    while process.poll() is None:
        if overflow.is_set():
            try:
                process.terminate()
            except OSError:
                pass
            break
        if time.monotonic() - start >= timeout:
            timed_out = True
            try:
                process.terminate()
            except OSError:
                pass
            break
        time.sleep(0.01)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    for reader in readers:
        reader.join(timeout=2.0)
    complete = all(not reader.is_alive() for reader in readers)
    out = bytes(captured["stdout"]).decode("utf-8", errors="replace")
    err = bytes(captured["stderr"]).decode("utf-8", errors="replace")
    was_truncated = overflow.is_set()
    exit_code = process.returncode if complete else None
    signal = -exit_code if exit_code is not None and exit_code < 0 else None
    normal_code = exit_code if exit_code is not None and exit_code >= 0 else None
    failure = "ENOBUFS" if was_truncated else "EOUTPUT_INCOMPLETE" if not complete else "ETIMEDOUT" if timed_out else "ESIGNAL" if signal is not None else None
    ok = failure is None and normal_code == 0
    return {"ok": ok, "code": failure or normal_code, "started": True,
            "exitCode": normal_code, "signal": signal, "timedOut": timed_out,
            "outputTruncated": was_truncated, "complete": complete,
            "stdout": out, "stderr": err, "stdoutBytes": counts["stdout"], "stderrBytes": counts["stderr"],
            "message": None if ok else failure or f"process exited with code {normal_code}"}
