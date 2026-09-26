#!/usr/bin/env python3
"""Add the optional local TaskPlanner → YouGile connector without secrets."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "yougile"
SCRIPTS = (
    "taskplanner-yougile-core.mjs",
    "taskplanner-yougile-history.mjs",
    "taskplanner-yougile-modules-core.mjs",
    "taskplanner-yougile-sync.mjs",
)
IGNORE = (
    ".tasks/yougile.local.json",
    ".tasks/yougile.local-state.json",
    ".tasks/yougile.local-hashes.json",
    ".tasks/yougile.api-key.txt",
    ".tasks/yougile.local*.tmp",
)
PROFILES = ("AGENTS.md", "CLAUDE.md", ".cursorrules")


def planned_actions(target: Path) -> tuple[list[tuple[Path, str]], list[str]]:
    board = target / ".tasks" / "config.json"
    if not board.is_file():
        raise ValueError("TaskPlanner board is missing; install project-task-system first")
    config = json.loads(board.read_text(encoding="utf-8"))
    states = {item["name"] for item in config.get("states", [])}
    needed = {"Backlog", "Next", "In Progress", "Done", "Rejected"}
    if not needed.issubset(states):
        raise ValueError("This connector needs the five standard TaskPlanner states")

    actions: list[tuple[Path, str]] = []
    conflicts: list[str] = []
    for name in SCRIPTS:
        destination = target / "tools" / name
        content = (ASSETS / name).read_text(encoding="utf-8")
        if not destination.exists():
            actions.append((destination, content))
        elif destination.read_text(encoding="utf-8") != content:
            conflicts.append(str(destination))

    example = target / ".tasks" / "yougile.example.json"
    if not example.exists():
        actions.append((example, (ASSETS / "yougile.example.json").read_text(encoding="utf-8")))
    elif example.read_text(encoding="utf-8") != (ASSETS / "yougile.example.json").read_text(encoding="utf-8"):
        conflicts.append(str(example))

    ignore = target / ".gitignore"
    old_ignore = ignore.read_bytes().decode("utf-8") if ignore.exists() else ""
    missing = [entry for entry in IGNORE if entry not in old_ignore.splitlines()]
    if missing:
        content = old_ignore + ("" if not old_ignore or old_ignore.endswith("\n") else "\n") + "\n".join(missing) + "\n"
        actions.append((ignore, content))

    rules = (ASSETS / "agent-rules.md").read_text(encoding="utf-8")
    for name in PROFILES:
        profile = target / name
        if not profile.exists():
            continue
        existing = profile.read_bytes().decode("utf-8")
        if "<!-- YOUGILE-SYNC:START -->" not in existing:
            actions.append((profile, existing + ("" if not existing or existing.endswith("\n") else "\n") + "\n" + rules))

    return actions, conflicts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="write planned files")
    parser.add_argument("--check", action="store_true", help="exit nonzero if setup is incomplete")
    args = parser.parse_args()
    if args.apply and args.check:
        parser.error("--apply and --check cannot be used together")
    target = args.target.resolve()
    if not target.is_dir():
        parser.error("--target must be an existing directory")
    try:
        actions, conflicts = planned_actions(target)
    except (OSError, ValueError, KeyError) as error:
        print(f"Cannot prepare YouGile connector: {error}", file=sys.stderr)
        return 2
    for destination, _ in actions:
        print(f"{'WRITE' if args.apply else 'PLAN'} {destination.relative_to(target)}")
    for conflict in conflicts:
        print(f"PRESERVE existing customized file: {Path(conflict).relative_to(target)}")
    if args.apply:
        if conflicts:
            print("Resolve customized-file conflicts before applying", file=sys.stderr)
            return 1
        for destination, content in actions:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content.encode("utf-8"))
    if args.check and (actions or conflicts):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
