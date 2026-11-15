#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collect_data.py — project-state 可视化数据收集器
------------------------------------------------
调用 project-state 只读命令收集项目状态，输出为前端 dashboard 可直接读取的：
  - data/live-data.js (定义 window.PROJECT_STATE_DATA)
  - data/live-data.json (独立 JSON，供导入或跨环境分析)

运行命令均为只读（list, show, doctor, compare, recover --inspect），
绝不触发任何写操作、restore 或 rollback。

使用方式:
    python tools/collect_data.py
    python tools/collect_data.py --project "d:/path/to/project" --cli "python -m project_state.cli"
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


_OUTPUT_LIMIT = 2 * 1024 * 1024
_TIMEOUT_SECONDS = 20


def run_cmd(cmd_list, cwd=None):
    """Run argv without a shell, enforce a timeout and bounded captured output."""
    proc = None
    try:
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            proc = subprocess.Popen(cmd_list, cwd=cwd, stdout=stdout_file, stderr=stderr_file,
                                    shell=False, close_fds=True)
            deadline = time.monotonic() + _TIMEOUT_SECONDS
            reason = None
            while proc.poll() is None:
                if (os.fstat(stdout_file.fileno()).st_size > _OUTPUT_LIMIT
                        or os.fstat(stderr_file.fileno()).st_size > _OUTPUT_LIMIT):
                    reason = "EOUTPUT_LIMIT"
                    proc.kill()
                    break
                if time.monotonic() >= deadline:
                    reason = "ETIMEDOUT"
                    proc.kill()
                    break
                time.sleep(0.025)
            proc.wait(timeout=5)
            stdout_size = os.fstat(stdout_file.fileno()).st_size
            stderr_size = os.fstat(stderr_file.fileno()).st_size
            stdout_file.seek(0)
            stderr_file.seek(0)
            stdout = stdout_file.read(_OUTPUT_LIMIT + 1).decode("utf-8", errors="replace")
            stderr = stderr_file.read(_OUTPUT_LIMIT + 1).decode("utf-8", errors="replace")
            if stdout_size > _OUTPUT_LIMIT or stderr_size > _OUTPUT_LIMIT:
                reason = reason or "EOUTPUT_LIMIT"
                stdout = stdout[:_OUTPUT_LIMIT]
                stderr = stderr[:_OUTPUT_LIMIT]
            if reason:
                return (-2 if reason == "ETIMEDOUT" else -3), stdout, f"{reason}: command did not produce a complete bounded result"
            return proc.returncode, stdout, stderr
    except (OSError, subprocess.SubprocessError) as exc:
        # Preserve the failure category without leaking executable paths or stderr.
        code = getattr(exc, "winerror", None) or getattr(exc, "errno", None)
        return -1, "", f"ESPAWN: {type(exc).__name__}:{code if code is not None else 'unknown'}"


def parse_json_result(stdout, *, command, version=None, schema=1):
    value = json.loads(stdout)
    if not isinstance(value, dict) or type(value.get("resultSchemaVersion")) is not int:
        raise ValueError("result schema version is missing")
    if value.get("resultSchemaVersion") != schema:
        raise ValueError("unsupported result schema version")
    if version is not None and value.get("toolVersion") != version:
        raise ValueError("tool version does not match the collected CLI version")
    if value.get("command") != command:
        raise ValueError("command identity does not match the request")
    return value


def error_code(stderr):
    """Expose only a syntactically valid error code, never private stderr."""
    match = re.match(r"^(E[A-Z0-9_]{1,63}):", stderr or "")
    return match.group(1) if match else "ECLI_FAILED"


def parse_general_doctor(stdout):
    """解析 project-state doctor (general) 文本输出为结构化对象"""
    lines = stdout.splitlines()
    tools = {}
    checks = []
    verdict = "unknown"

    tool_re = re.compile(r"^(Git|SQLite CLI|Python SQLite|Node|npm|docker):\s*(.*)$", re.IGNORECASE)
    check_re = re.compile(r"^([^:]+):\s*(ok|issue|unknown|not-applicable)\s*\[([^\]]+)\]\s*-\s*(.*)$", re.IGNORECASE)
    verdict_re = re.compile(r"^Verdict:\s*(ok|issue|unknown)", re.IGNORECASE)

    for line in lines:
        line_clean = line.strip()
        t_m = tool_re.match(line_clean)
        if t_m:
            tools[t_m.group(1)] = t_m.group(2).strip()
            continue
        c_m = check_re.match(line_clean)
        if c_m:
            checks.append({
                "id": c_m.group(1).strip(),
                "state": c_m.group(2).strip(),
                "reasonCode": c_m.group(3).strip(),
                "detail": c_m.group(4).strip()
            })
            continue
        v_m = verdict_re.match(line_clean)
        if v_m:
            verdict = v_m.group(1).strip()

    return {
        "tools": tools,
        "checks": checks,
        "verdict": verdict,
        "raw": stdout
    }


def main():
    parser = argparse.ArgumentParser(description="project-state 状态收集脚本")
    parser.add_argument("--project", "-p", default=os.getcwd(), help="目标项目目录（默认为当前工作区）")
    parser.add_argument("--cli", default="project-state", help="CLI 执行命令（支持 'python -m project_state.cli' 或 'project-state'）")
    parser.add_argument("--cli-argv", help="JSON argv 数组；Windows 下用于无歧义传递可执行文件和参数")
    parser.add_argument("--out-dir", default=None, help="前端输出目录（默认自动定位到 dashboard/data）")
    parser.add_argument("--operation", action="append", default=[], help="需额外 inspect 的 operationId")
    args = parser.parse_args()

    project_root = Path(args.project).resolve()
    if args.cli_argv:
        try:
            base_cli = json.loads(args.cli_argv)
        except json.JSONDecodeError:
            parser.error("--cli-argv must be a JSON string array")
        if (not isinstance(base_cli, list) or not base_cli or
                any(not isinstance(part, str) or not part or "\x00" in part for part in base_cli)):
            parser.error("--cli-argv must contain non-empty strings without NUL")
    elif os.name == "nt":
        if args.cli != "project-state":
            parser.error("on Windows use --cli-argv '[\"python.exe\",\"-m\",\"project_state.cli\"]' or a single executable path with --cli")
        base_cli = [args.cli]
    else:
        base_cli = shlex.split(args.cli, posix=True)

    dashboard_dir = Path(__file__).resolve().parent.parent / "dashboard"
    out_dir = Path(args.out_dir).resolve() if args.out_dir else dashboard_dir / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[*] 目标项目: {project_root}")
    print(f"[*] CLI 命令: {' '.join(base_cli)}")
    print(f"[*] 数据输出: {out_dir}")

    meta = {
        "source": "live",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "projectRoot": str(project_root),
        "projectLabel": project_root.name,
        "cliCommand": args.cli,
        "errors": []
    }

    # 1. 查询版本
    rc, stdout, stderr = run_cmd(base_cli + ["--version"], cwd=project_root)
    if rc == 0:
        meta["toolVersion"] = stdout.strip()
    else:
        meta["toolVersion"] = "unknown"
        meta["errors"].append({"command": "version", "exitCode": rc, "error": error_code(stderr)})

    # 2. 获取快照列表 list --json
    list_data = None
    rc, stdout, stderr = run_cmd(base_cli + ["list", "--json"], cwd=project_root)
    if rc >= 0 and stdout.strip().startswith("{"):
        try:
            list_data = parse_json_result(stdout, command="list", version=meta.get("toolVersion"), schema=2)
            if (not isinstance(list_data.get("snapshots"), list)
                    or any(not isinstance(item, dict) or not isinstance(item.get("name"), str)
                           or not isinstance(item.get("state"), str) for item in list_data["snapshots"])):
                raise ValueError("invalid snapshot list")
            list_data["observedExitCode"] = rc
        except Exception as e:
            list_data = None
            meta["errors"].append({"command": "list --json", "exitCode": rc, "error": type(e).__name__})
    else:
        meta["errors"].append({"command": "list --json", "exitCode": rc, "error": error_code(stderr) if stderr else "EJSON_MISSING"})

    snapshots = (list_data or {}).get("snapshots", [])

    # 3. 对每个快照执行 show --json 补充细节（若 list 未展开）
    detailed_snaps = []
    for s in snapshots:
        name = s.get("name")
        if not name or s.get("state") in ("invalid", "missing"):
            detailed_snaps.append(s)
            continue
        rc, stdout, stderr = run_cmd(base_cli + ["show", name, "--json"], cwd=project_root)
        if rc >= 0 and stdout.strip().startswith("{"):
            try:
                res = parse_json_result(stdout, command="show", version=meta.get("toolVersion"), schema=2)
                detail = res.get("snapshot")
                if not isinstance(detail, dict) or detail.get("name") != name:
                    raise ValueError("show snapshot identity is invalid")
                detailed_snaps.append({**detail, "observedExitCode": rc})
                continue
            except Exception as e:
                meta["errors"].append({"command": "show --json", "name": name,
                                       "exitCode": rc, "error": type(e).__name__})
        else:
            meta["errors"].append({"command": "show --json", "name": name,
                                   "exitCode": rc, "error": error_code(stderr) if stderr else "EJSON_MISSING"})
        detailed_snaps.append(s)
    if list_data:
        list_data["snapshots"] = detailed_snaps

    # 4. 执行通用只读诊断 doctor
    doctor_general = None
    rc, stdout, stderr = run_cmd(base_cli + ["doctor", "--json"], cwd=project_root)
    if rc >= 0 and stdout.strip().startswith("{"):
        try:
            raw = parse_json_result(stdout, command="doctor", version=meta.get("toolVersion"), schema=1)
            if raw.get("mode") != "general" or not isinstance(raw.get("checks"), list) or not isinstance(raw.get("tools"), dict):
                raise ValueError("general doctor fields are invalid")
            tool_values = {key: (value.get("version") if isinstance(value, dict) else value)
                           for key, value in raw["tools"].items()}
            doctor_general = {"resultSchemaVersion": 1, "toolVersion": raw["toolVersion"],
                              "command": "doctor", "tools": tool_values,
                              "checks": [{**check, "detail": check.get("detail", check.get("message", ""))}
                                         for check in raw["checks"]],
                              "verdict": raw.get("summary", {}).get("state", "unknown"),
                              "rawText": None, "observedExitCode": rc}
        except Exception as e:
            meta["errors"].append({"command": "doctor --json", "exitCode": rc, "error": type(e).__name__})
    else:
        meta["errors"].append({"command": "doctor --json", "exitCode": rc,
                               "error": error_code(stderr) if stderr else "EJSON_MISSING"})

    # 5. 执行任务级只读诊断 doctor --task ... --json
    doctor_tasks = []
    for task_name in ["config-snapshot"]:
        rc, stdout, stderr = run_cmd(base_cli + ["doctor", "--task", task_name, "--json"], cwd=project_root)
        if rc >= 0 and stdout.strip().startswith("{"):
            try:
                task_result = parse_json_result(stdout, command="doctor", version=meta.get("toolVersion"), schema=1)
                task_result["observedExitCode"] = rc
                doctor_tasks.append(task_result)
            except Exception as e:
                meta["errors"].append({"command": "doctor --task", "task": task_name,
                                       "exitCode": rc, "error": type(e).__name__})
        else:
            meta["errors"].append({"command": "doctor --task", "task": task_name,
                                   "exitCode": rc, "error": error_code(stderr) if stderr else "EJSON_MISSING"})

    if snapshots:
        # 为最新的有效快照执行 config-restore 诊断
        first_valid = next((s["name"] for s in snapshots if s.get("state") == "verified"), None)
        if first_valid:
            rc, stdout, stderr = run_cmd(base_cli + ["doctor", "--task", "config-restore", "--snapshot", first_valid, "--json"], cwd=project_root)
            if rc >= 0 and stdout.strip().startswith("{"):
                try:
                    task_result = parse_json_result(stdout, command="doctor", version=meta.get("toolVersion"), schema=1)
                    task_result["observedExitCode"] = rc
                    doctor_tasks.append(task_result)
                except Exception as e:
                    meta["errors"].append({"command": "doctor --task", "task": "config-restore",
                                           "exitCode": rc, "error": type(e).__name__})
            else:
                meta["errors"].append({"command": "doctor --task", "task": "config-restore",
                                       "exitCode": rc, "error": error_code(stderr) if stderr else "EJSON_MISSING"})

    # 6. 对比（compare）
    compares = []
    verified_names = [s["name"] for s in snapshots if s.get("state") == "verified"]
    if verified_names:
        # 最新 vs live
        latest = verified_names[0]
        rc, stdout, stderr = run_cmd(base_cli + ["compare", latest], cwd=project_root)
        if rc >= 0 and stdout:
            compares.append({"a": latest, "b": None, "exitCode": rc, "text": stdout})
        elif rc < 0:
            meta["errors"].append({"command": "compare", "exitCode": rc, "error": error_code(stderr)})
        # 最新 vs 上一个
        if len(verified_names) > 1:
            prev = verified_names[1]
            rc, stdout, stderr = run_cmd(base_cli + ["compare", prev, latest], cwd=project_root)
            if rc >= 0 and stdout:
                compares.append({"a": prev, "b": latest, "exitCode": rc, "text": stdout})
            elif rc < 0:
                meta["errors"].append({"command": "compare", "exitCode": rc, "error": error_code(stderr)})

    # 7. 恢复操作日志 (recover <id> --inspect)
    operations = []
    for op_id in args.operation:
        rc, stdout, stderr = run_cmd(base_cli + ["recover", op_id, "--inspect"], cwd=project_root)
        if rc >= 0 and stdout.strip().startswith("{"):
            try:
                operation = json.loads(stdout)
                if (not isinstance(operation, dict) or operation.get("resultSchemaVersion") != 1
                        or operation.get("operationId") != op_id):
                    raise ValueError("recover result identity is invalid")
                operation["observedExitCode"] = rc
                operations.append(operation)
            except Exception as e:
                meta["errors"].append({"command": "recover --inspect", "operationId": op_id,
                                       "exitCode": rc, "error": type(e).__name__})
        else:
            meta["errors"].append({"command": "recover --inspect", "operationId": op_id,
                                   "exitCode": rc, "error": error_code(stderr) if stderr else "EJSON_MISSING"})

    bundle = {
        "bundleSchema": "project-state-dashboard/1",
        "meta": meta,
        "list": list_data,
        "doctor": {
            "general": doctor_general,
            "tasks": doctor_tasks
        },
        "compares": compares,
        "operations": operations,
        "demo": None
    }

    # 写出 live-data.json
    json_path = out_dir / "live-data.json"
    json_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    # Keep console summaries representable in the active Windows code page.
    # The generated files remain UTF-8; console encoding must not turn a
    # successful collection into a post-write exception.
    print(f"[OK] 成功写出 JSON: {json_path}")

    # 写出 live-data.js (window.PROJECT_STATE_DATA = ...)
    js_content = "/* 自动生成的数据文件，由 tools/collect_data.py 输出 */\nwindow.PROJECT_STATE_DATA = " + json.dumps(bundle, ensure_ascii=False, indent=2) + ";\n"
    js_path = out_dir / "live-data.js"
    js_path.write_text(js_content, encoding="utf-8")
    print(f"[OK] 成功写出 JS:   {js_path}")
    print("[*] 完成！现在可以在浏览器中打开 dashboard/index.html 查看最新状态数据。")


if __name__ == "__main__":
    main()
