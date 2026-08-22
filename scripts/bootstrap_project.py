#!/usr/bin/env python3
"""Safely add a portable TaskPlanner project system to a repository."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_ROOT = SKILL_ROOT / "assets" / "project-template"
MANAGED_MARKERS = ("PROJECT-SYSTEM", "TASKPLANNER")
PROFILE_TEMPLATES = {
    Path("AGENTS.md"): Path("AGENTS.md"),
    Path("CLAUDE.md"): Path("CLAUDE.md"),
    Path("cursorrules"): Path(".cursorrules"),
}
STATIC_TEMPLATE_GROUPS = {
    "docs": Path("docs"),
    "github": Path(".github"),
}
REQUIRED_DOCS = (
    "current-task.md",
    "product.md",
    "architecture.md",
    "integrations.md",
    "decisions.md",
    "deployment.md",
    "quality.md",
)


@dataclass(frozen=True)
class Action:
    kind: str
    destination: Path
    content: str | None
    reason: str


def render(content: str, project_name: str, taskplanner_version: str) -> str:
    return content.replace("%PROJECT_NAME%", project_name).replace(
        "%TASKPLANNER_VERSION%", taskplanner_version
    )


def read_template(
    relative: Path, project_name: str, taskplanner_version: str
) -> str:
    return render(
        (TEMPLATE_ROOT / relative).read_text(encoding="utf-8"),
        project_name,
        taskplanner_version,
    )


def marker_pattern(marker: str) -> re.Pattern[str]:
    return re.compile(
        rf"<!-- {re.escape(marker)}:START -->.*?<!-- {re.escape(marker)}:END -->",
        re.DOTALL,
    )


def merge_profile(existing: str, template: str, refresh_managed: bool) -> str:
    merged = existing
    for marker in MANAGED_MARKERS:
        pattern = marker_pattern(marker)
        source = pattern.search(template)
        if source is None:
            raise ValueError(f"Template is missing managed block {marker}")
        current = pattern.search(merged)
        if current is not None:
            if refresh_managed:
                merged = pattern.sub(source.group(0), merged, count=1)
            continue
        merged = merged.rstrip() + "\n\n" + source.group(0) + "\n"
    return merged


def template_files(group: str) -> list[Path]:
    root = TEMPLATE_ROOT / group
    return sorted(path for path in root.rglob("*") if path.is_file())


def build_actions(
    target: Path,
    project_name: str,
    taskplanner_version: str,
    refresh_managed: bool = False,
) -> list[Action]:
    actions: list[Action] = []

    for source_relative, destination_relative in PROFILE_TEMPLATES.items():
        destination = target / destination_relative
        template = read_template(source_relative, project_name, taskplanner_version)
        if not destination.exists():
            actions.append(Action("create", destination, template, "profile is missing"))
            continue
        existing = destination.read_text(encoding="utf-8")
        merged = merge_profile(existing, template, refresh_managed)
        if merged != existing:
            reason = "refresh managed blocks" if refresh_managed else "append missing blocks"
            actions.append(Action("update", destination, merged, reason))
        else:
            actions.append(Action("preserve", destination, None, "managed blocks present"))

    board_exists = (target / ".tasks" / "config.json").exists()
    for source in template_files("tasks"):
        relative = source.relative_to(TEMPLATE_ROOT / "tasks")
        destination = target / ".tasks" / relative
        if board_exists:
            actions.append(
                Action("preserve", destination, None, "existing board owns TaskPlanner files")
            )
        elif destination.exists():
            actions.append(Action("preserve", destination, None, "file already exists"))
        else:
            content = render(
                source.read_text(encoding="utf-8"), project_name, taskplanner_version
            )
            actions.append(Action("create", destination, content, "board file is missing"))

    for group, destination_root in STATIC_TEMPLATE_GROUPS.items():
        source_root = TEMPLATE_ROOT / group
        for source in template_files(group):
            relative = source.relative_to(source_root)
            destination = target / destination_root / relative
            if destination.exists():
                actions.append(Action("preserve", destination, None, "file already exists"))
            else:
                content = render(
                    source.read_text(encoding="utf-8"), project_name, taskplanner_version
                )
                actions.append(Action("create", destination, content, "template is missing"))

    return actions


def apply_actions(actions: list[Action]) -> None:
    for action in actions:
        if action.kind not in {"create", "update"}:
            continue
        if action.content is None:
            raise ValueError(f"No content supplied for {action.destination}")
        action.destination.parent.mkdir(parents=True, exist_ok=True)
        action.destination.write_text(action.content, encoding="utf-8", newline="\n")


def relative_display(path: Path, target: Path) -> str:
    try:
        return str(path.relative_to(target))
    except ValueError:
        return str(path)


def print_actions(actions: list[Action], target: Path, applying: bool) -> None:
    mode = "APPLY" if applying else "PREVIEW"
    print(f"{mode}: {target}")
    for action in actions:
        print(
            f"{action.kind.upper():8} {relative_display(action.destination, target)}"
            f" - {action.reason}"
        )
    counts = {
        kind: sum(action.kind == kind for action in actions)
        for kind in ("create", "update", "preserve")
    }
    print(
        "Summary: "
        f"create={counts['create']} update={counts['update']} "
        f"preserve={counts['preserve']}"
    )


def check_system(target: Path) -> list[str]:
    problems: list[str] = []
    config_path = target / ".tasks" / "config.json"
    if not config_path.exists():
        problems.append("missing .tasks/config.json")
    else:
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            states = config.get("states", [])
            if not isinstance(states, list) or not states:
                problems.append(".tasks/config.json has no task states")
            else:
                for state in states:
                    file_name = state.get("fileName") if isinstance(state, dict) else None
                    if not file_name or not (target / ".tasks" / file_name).exists():
                        problems.append(f"missing configured task state file: {file_name}")
        except (json.JSONDecodeError, OSError) as error:
            problems.append(f"invalid .tasks/config.json: {error}")

    if not (target / ".tasks" / "WORK_LOG.md").exists():
        problems.append("missing .tasks/WORK_LOG.md")

    for profile in ("AGENTS.md", "CLAUDE.md", ".cursorrules"):
        path = target / profile
        if not path.exists():
            problems.append(f"missing {profile}")
            continue
        content = path.read_text(encoding="utf-8")
        for marker in MANAGED_MARKERS:
            if marker_pattern(marker).search(content) is None:
                problems.append(f"{profile} is missing {marker} managed block")

    for document in REQUIRED_DOCS:
        if not (target / "docs" / document).exists():
            problems.append(f"missing docs/{document}")
    return problems


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Preview, apply, or validate a portable TaskPlanner project system."
    )
    parser.add_argument("--target", default=".", help="Target repository directory")
    parser.add_argument("--project-name", help="Display name used in new templates")
    parser.add_argument(
        "--taskplanner-version",
        default="2.1.1",
        help="Version recorded only when creating a new board (default: 2.1.1)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Write the planned changes")
    mode.add_argument("--check", action="store_true", help="Validate an installed system")
    parser.add_argument(
        "--refresh-managed",
        action="store_true",
        help="Replace only existing managed profile blocks with bundled versions",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    target = Path(args.target).expanduser().resolve()
    if not target.exists() or not target.is_dir():
        print(f"Target directory does not exist: {target}", file=sys.stderr)
        return 2
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", args.taskplanner_version):
        print("--taskplanner-version must be a semantic version", file=sys.stderr)
        return 2

    if args.check:
        problems = check_system(target)
        if problems:
            print(f"CHECK FAILED: {target}")
            for problem in problems:
                print(f"- {problem}")
            return 1
        print(f"CHECK OK: {target}")
        return 0

    project_name = args.project_name or target.name
    actions = build_actions(
        target,
        project_name,
        args.taskplanner_version,
        refresh_managed=args.refresh_managed,
    )
    print_actions(actions, target, applying=args.apply)
    if args.apply:
        apply_actions(actions)
        problems = check_system(target)
        if problems:
            print("Post-apply validation failed:", file=sys.stderr)
            for problem in problems:
                print(f"- {problem}", file=sys.stderr)
            return 1
        print("Post-apply validation: OK")
    else:
        print("No files were changed. Re-run with --apply after reviewing the preview.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
