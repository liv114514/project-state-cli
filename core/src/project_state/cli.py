from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from . import __version__
from .contracts.errors import ProjectStateError, UnsupportedError
from .application import (compare, doctor, task_doctor, inspect_inventory, inspect_one,
    validate_snapshot_name, create_snapshot, plan_git_restore, plan_config_restore,
    apply_database_restore, plan_database_restore, apply_config_restore, recover, run_demo,
    describe_error)

_HELP = """project-state (Python migration candidate)

Commands:
  help [command]       Show help
  --version            Show candidate version
  doctor               Run read-only general diagnosis
  doctor --task config-snapshot [--json]
  doctor --task config-restore --snapshot <name> [--json]
  snapshot <name> [--with-seed] Save a new v2 snapshot; seed requires SQLite 3.51.3+ and a private online backup
  restore <name> --only config|git [--json] [--yes]  Preview supported restore scope; config supports one file or the .env/.env.local pair, Git apply remains disabled
  restore <name> --only database --target <db-file> [--json] [--yes]  Windows: create one verified database at a missing destination
  recover <operation-id> --inspect|--continue|--rollback [--yes]
  list [--json]        Inspect snapshot inventory
  show <name> [--json] Validate and inspect one snapshot
  compare <name> [<nameB>] Compare supported Git/config/dependency/runtime evidence
  demo                 Run a disposable synthetic config restore/rollback
  state-location show Show the current state-root selection (read-only)
  state-location check <path> Check a private same-volume location without writing
  state-location init <path> Initialize a new project at an explicit private location
  prune                Not available in this candidate; no deletion is performed
  hook                 Not available in this candidate; no hook is changed

Restore apply requires --yes. Config restore supports one file or the allowlisted
.env/.env.local pair with a private safety snapshot. Pair publication is per-file,
not an atomic multi-file view; interrupted work requires verified recovery.
SQLite restore creates an absent root-level database only and
refuses existing targets or sidecars. SQLite restore is currently enabled only
on verified Windows no-replace publication; rollback removes the project target
but retains its verified database in private quarantine. Both use journals and recover.
Config and SQLite restore require the project and private state to be on the same
filesystem volume. A verified not-applied config or SQLite publication can be
cancelled with recover --rollback; this does not mean the snapshot was restored.
  Git checkout, prune, and hook remain unavailable and fail closed. Snapshot
publication is limited to allowlisted config/dependency/runtime layers, never
overwrites an existing name, and records Git/Docker as available or skipped;
database collection requires explicit --with-seed, SQLite 3.51.3+, and online backup.
Git restore provides a validated read-only preview only; applying Git changes is disabled.
"""

_COMMANDS = {"snapshot", "compare", "restore", "recover", "doctor", "list", "show", "prune", "hook", "demo", "state-location"}


def _parse_flags(argv: list[str], permitted: set[str]) -> tuple[list[str], set[str]]:
    positional: list[str] = []
    flags: set[str] = set()
    for item in argv:
        if item.startswith("--"):
            if item not in permitted:
                raise ProjectStateError("EARG_UNKNOWN", "unknown option; run project-state help", 1)
            if item in flags:
                raise ProjectStateError("EARG_DUPLICATE", f"duplicate option: {item}", 1)
            flags.add(item)
        else:
            positional.append(item)
    return positional, flags


def _parse_doctor(argv: list[str]) -> tuple[str | None, str | None, bool]:
    values: dict[str, str] = {}
    json_output = False
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--json":
            if json_output:
                raise ProjectStateError("EARG_DUPLICATE", "duplicate option: --json", 1)
            json_output = True
        elif item in {"--task", "--snapshot"}:
            key = item[2:]
            if key in values:
                raise ProjectStateError("EARG_DUPLICATE", f"duplicate option: {item}", 1)
            index += 1
            if index >= len(argv) or argv[index].startswith("--"):
                raise ProjectStateError("EARG_VALUE", f"{item} requires a value", 1)
            values[key] = argv[index]
        elif item.startswith("--"):
            raise ProjectStateError("EARG_UNKNOWN", "unknown option; run project-state help", 1)
        else:
            raise ProjectStateError("EARG_SYNTAX", "doctor accepts no positional arguments", 1)
        index += 1
    task, snapshot = values.get("task"), values.get("snapshot")
    if snapshot and task != "config-restore":
        raise ProjectStateError("EARG_CONFLICT", "--snapshot is valid only with --task config-restore", 1)
    if task == "config-restore" and snapshot is None:
        raise ProjectStateError("EARG_VALUE", "config-restore requires --snapshot <name>", 1)
    if task is None and snapshot is not None:
        raise ProjectStateError("EARG_CONFLICT", "--snapshot requires --task config-restore", 1)
    return task, snapshot, json_output


def _parse_restore(argv: list[str]) -> tuple[str, str, str | None, bool, bool]:
    name: str | None = None
    only: str | None = None
    target: str | None = None
    json_output = False
    confirm = False
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--json":
            if json_output:
                raise ProjectStateError("EARG_DUPLICATE", "duplicate option: --json", 1)
            json_output = True
        elif item == "--yes":
            if confirm:
                raise ProjectStateError("EARG_DUPLICATE", "duplicate option: --yes", 1)
            confirm = True
        elif item == "--only":
            if only is not None:
                raise ProjectStateError("EARG_DUPLICATE", "duplicate option: --only", 1)
            index += 1
            if index >= len(argv) or argv[index].startswith("--"):
                raise ProjectStateError("EARG_VALUE", "--only requires a value", 1)
            only = argv[index]
        elif item == "--target":
            if target is not None:
                raise ProjectStateError("EARG_DUPLICATE", "duplicate option: --target", 1)
            index += 1
            if index >= len(argv) or argv[index].startswith("--"):
                raise ProjectStateError("EARG_VALUE", "--target requires a value", 1)
            target = argv[index]
        elif item.startswith("--"):
            raise ProjectStateError("EARG_UNKNOWN", "unknown option; run project-state help", 1)
        else:
            if name is not None:
                raise ProjectStateError("EARG_SYNTAX", "restore accepts exactly one snapshot name", 1)
            name = item
        index += 1
    if name is None:
        raise ProjectStateError("EARG_SYNTAX", "restore requires exactly one snapshot name", 1)
    if only not in {"config", "git", "database"}:
        raise ProjectStateError("ERESTORE_SELECTION", "this migration slice supports --only config, git, or database preview", 2)
    if target is not None and only != "database":
        raise ProjectStateError("EARG_CONFLICT", "--target is valid only with --only database", 1)
    if only == "database" and target is None:
        raise ProjectStateError("EARG_VALUE", "--only database requires --target <db-file>", 1)
    return name, only, target, json_output, confirm


def _parse_recover(argv: list[str]) -> tuple[str, str, bool]:
    if not argv:
        raise ProjectStateError("EARG_SYNTAX", "recover requires an operation ID and one action", 1)
    operation_id = argv[0]
    if len(operation_id) != 32 or any(ch not in "0123456789abcdef" for ch in operation_id):
        raise ProjectStateError("EARG_VALUE", "recover operation ID is invalid", 1)
    actions = {"--inspect": "inspect", "--continue": "continue", "--rollback": "rollback"}
    found = [actions[item] for item in argv[1:] if item in actions]
    confirm = argv.count("--yes") == 1
    if len(found) != 1 or len([item for item in argv[1:] if item in actions]) != 1:
        raise ProjectStateError("EARG_CONFLICT", "recover requires exactly one of --inspect, --continue, or --rollback", 1)
    for item in argv[1:]:
        if item not in actions and item != "--yes":
            raise ProjectStateError("EARG_UNKNOWN", "unknown recover option; run project-state help", 1)
    if argv.count("--yes") > 1:
        raise ProjectStateError("EARG_DUPLICATE", "duplicate option: --yes", 1)
    if found[0] == "inspect" and confirm:
        raise ProjectStateError("EARG_CONFLICT", "--yes is not valid with read-only recover --inspect", 1)
    if found[0] != "inspect" and not confirm:
        raise ProjectStateError("EARG_CONFIRM", "recover --continue/--rollback requires explicit --yes", 1)
    return operation_id, found[0], confirm


def _json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _unsupported(command: str) -> None:
    raise UnsupportedError(f"{command} is not enabled in this Python candidate; no project state was changed")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if not args or args in (["help"], ["--help"], ["-h"]):
            print(_HELP)
            return 0
        if args == ["--version"] or args == ["-v"]:
            print(__version__)
            return 0
        if args[0] == "help":
            if len(args) != 2 or args[1] not in _COMMANDS:
                raise ProjectStateError("EARG_HELP_TOPIC", "unknown help topic", 1)
            print(f"project-state {args[1]} — Python migration candidate\nSee the main help and migration matrix for current implementation status.")
            return 0
        command, rest = args[0], args[1:]
        if command not in _COMMANDS:
            raise ProjectStateError("EARG_COMMAND", "unknown command; run project-state help", 1)
        if any(x in {"--help", "-h"} for x in rest):
            if len(rest) != 1:
                raise ProjectStateError("EARG_SYNTAX", "help option cannot be combined with other arguments", 1)
            print(f"project-state {command}: see main help; migration status is explicitly scoped.")
            return 0
        root = Path.cwd()
        if command == "state-location":
            from .foundation.state_location import (check_state_location,
                initialize_state_location, inspect_state_location)
            if rest == ["show"]:
                result = inspect_state_location(root)
                _json(result)
                return 0
            if len(rest) == 2 and rest[0] == "check":
                result = check_state_location(root, Path(rest[1]))
                _json(result)
                return 0
            if len(rest) == 2 and rest[0] == "init":
                result = initialize_state_location(root, Path(rest[1]))
                _json(result)
                return 0
            raise ProjectStateError("EARG_STATE_LOCATION", "use state-location show, check <path>, or init <path>", 1)
        if command == "doctor":
            task, snapshot, json_output = _parse_doctor(rest)
            if task is None:
                if rest and not (json_output and rest == ["--json"]):
                    raise ProjectStateError("EARG_SYNTAX", "general doctor accepts no options or positional arguments", 1)
                result = doctor(root)
                if json_output:
                    _json(result)
                    return 1 if result["summary"]["state"] == "issue" else 0
                print(f"Git: {result['tools']['git']['version'] or 'unavailable'}")
                print(f"SQLite CLI: {result['tools']['sqliteCli']['version'] or 'unavailable'}")
                print(f"Python SQLite: {result['tools']['pythonSqlite']['version']}")
                for check in result["checks"]:
                    print(f"{check['id']}: {check['state']} [{check['reasonCode']}] - {check['detail']}")
                print(f"Verdict: {result['summary']['state']}.")
                print("This is a read-only tool check; restore readiness and application health were not tested.")
                return 1 if result["summary"]["state"] == "issue" else 0
            result = task_doctor(root, task, snapshot)
            if json_output:
                _json(result)
            else:
                print(f"Task readiness: {result['summary']['state']} ({task})")
                for check in result["checks"]:
                    print(f"{check['id']}: {check['state']} [{check['reasonCode']}] — {check['message']}")
                print("No write or recovery was attempted; application health is not tested.")
            return 1 if task and result["summary"]["state"] == "blocked" else 2 if task and result["summary"]["state"] == "unknown" else 0
        if command == "list":
            positional, flags = _parse_flags(rest, {"--json"})
            if positional:
                raise ProjectStateError("EARG_SYNTAX", "list accepts no positional arguments", 1)
            result = inspect_inventory(root)
            if "--json" in flags:
                _json(result)
            elif result["inventory"]["state"] == "unreadable":
                print("Snapshot inventory is unreadable; no changes were made.", file=sys.stderr)
            elif result["inventory"]["snapshotCount"] == 0:
                print(f"Snapshot inventory: {result['inventory']['state']}; application health not tested.")
            else:
                for row in result["snapshots"]:
                    print(f"{row['name']} {row['state']} generation={row.get('generation', '(unknown)')}")
                print("Stored input integrity does not establish application health.")
            return 2 if result["inventory"]["state"] == "unreadable" else 0
        if command == "show":
            positional, flags = _parse_flags(rest, {"--json"})
            if len(positional) != 1:
                raise ProjectStateError("EARG_SYNTAX", "show requires exactly one snapshot name", 1)
            validate_snapshot_name(positional[0])
            row = inspect_one(root, positional[0])
            output = {"resultSchemaVersion": 2, "toolVersion": __version__, "command": "show", "snapshot": row}
            if "--json" in flags:
                _json(output)
            else:
                print(f"{row['name']}: {row['state']} (health not tested)")
            return 1 if row["state"] == "missing" else (2 if row["state"] in {"invalid", "incomplete", "unreadable"} else 0)
        if command == "compare":
            positional, flags = _parse_flags(rest, set())
            if flags or len(positional) not in {1, 2}:
                raise ProjectStateError("EARG_SYNTAX", "compare requires one snapshot and optionally a second", 1)
            code, output = compare(root, positional[0], positional[1] if len(positional) == 2 else None)
            print(output)
            return code
        if command == "restore":
            name, selection, database_target, json_output, confirm = _parse_restore(rest)
            validate_snapshot_name(name)
            if selection == "git":
                if confirm:
                    raise UnsupportedError("Git checkout apply is not enabled in this Python candidate; no project state was changed")
                result = plan_git_restore(root, name)
                if json_output:
                    _json(result)
                else:
                    target = result["target"]
                    print(f"Git restore preview for {result['snapshot']} generation {result['generation']}:")
                    print(f"target: {target['commit']} ({target['headMode']}; refs will not be changed by this preview)")
                    print(f"changed paths: {result['changedPathCount']}; apply: not supported yet")
                    print("No checkout, index update, ref change, or business write occurred.")
                return 0
            if selection == "database":
                if confirm:
                    result = apply_database_restore(root, name, database_target)
                    print(f"SQLite restore verified for {result['target']} from {result['snapshot']} generation {result['generation']}.")
                    print(f"Operation: {result['operationId']}; rollback with: project-state recover {result['operationId']} --rollback --yes")
                    print("Integrity: ok; schema and row counts verified; application health: not tested.")
                    return 0
                result = plan_database_restore(root, name, database_target)
                if json_output:
                    _json(result)
                else:
                    print(f"SQLite restore preview for {result['snapshot']} generation {result['generation']}:")
                    print(f"create: {database_target}; existing targets and sidecars are refused; values withheld")
                    print("No project files or database state were changed by this preview.")
                return 0
            if confirm:
                result = apply_config_restore(root, name)
                if result.get("status") == "unchanged":
                    print(f"No config changes were needed for {result['snapshot']} generation {result['generation']}.")
                    return 0
                targets = result.get("targets") or [result["target"]]
                print(f"Restore verified for {', '.join(targets)} from {result['snapshot']} generation {result['generation']}.")
                print(f"Safety snapshot: {result['safety']['name']} generation {result['safety']['generation']}.")
                print(f"Operation: {result['operationId']}; rollback with: project-state recover {result['operationId']} --rollback --yes")
                print("Application health: not tested.")
                return 0
            result = plan_config_restore(root, name)
            if json_output:
                _json(result)
            else:
                print(f"Restore preview for {result['snapshot']} generation {result['generation']}:")
                for target in result["targets"]:
                    print(f"{target['action']}: {target['target']} (values withheld)")
                print("No project files or Git state were changed. Apply is limited to the listed supported config targets; use --yes only after reviewing that scope.")
            return 0
        if command == "recover":
            operation_id, action, _ = _parse_recover(rest)
            result = recover(root, operation_id, action)
            _json(result)
            return 0 if action == "inspect" or result.get("status") in {"verified", "completed", "rolled-back", "cancelled"} else 2
        if command == "demo":
            if rest:
                raise ProjectStateError("EARG_SYNTAX", "demo accepts no arguments", 1)
            result = run_demo()
            _json(result)
            return 0
        if command == "snapshot":
            positional, flags = _parse_flags(rest, {"--with-seed"})
            if len(positional) != 1:
                raise ProjectStateError("EARG_SYNTAX", "snapshot requires exactly one new snapshot name", 1)
            saved = create_snapshot(root, positional[0], with_seed="--with-seed" in flags)
            skipped = [key for key, value in saved["layerStatus"].items() if value["status"] == "skipped"]
            collected = [key for key, value in saved["layerStatus"].items() if value["status"] == "collected"]
            print(f'Snapshot "{saved["name"]}" generation {saved["generation"]} saved and verified.')
            print(f'Completeness: {"PARTIAL" if saved["partial"] else "all configured layers collected"}.')
            print(f'Collected layers: {", ".join(collected) if collected else "(none)"}.')
            if skipped:
                print(f'Skipped layers: {", ".join(skipped)}; see the snapshot metadata for reasons.')
            print("Raw supported files are private plaintext; filesystem access controls are outside this check.")
            return 0
        _unsupported(command)
    except ProjectStateError as exc:
        diagnostic = describe_error(exc)
        print(f"{diagnostic.code}: {diagnostic.message}\nAffected: {diagnostic.object_kind}.\nNext: {diagnostic.next_step}", file=sys.stderr)
        return exc.exit_code
    except Exception:
        # Avoid leaking private paths, environment content, or tracebacks.
        diagnostic = describe_error(ProjectStateError("EINTERNAL", "command failed safely", 2))
        print(f"{diagnostic.code}: {diagnostic.message}\nAffected: {diagnostic.object_kind}.\nNext: {diagnostic.next_step}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
