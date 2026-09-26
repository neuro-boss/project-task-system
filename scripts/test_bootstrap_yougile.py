from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("bootstrap_yougile.py")
SPEC = importlib.util.spec_from_file_location("bootstrap_yougile", SCRIPT)
assert SPEC and SPEC.loader
bootstrap = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bootstrap
SPEC.loader.exec_module(bootstrap)


def prepare_board(target: Path) -> None:
    board = target / ".tasks" / "config.json"
    board.parent.mkdir()
    board.write_text(
        json.dumps({"states": [{"name": state, "fileName": filename} for state, filename in
                             (("Backlog", "BACKLOG.md"), ("Next", "NEXT.md"),
                              ("In Progress", "IN_PROGRESS.md"), ("Done", "DONE.md"),
                              ("Rejected", "REJECTED.md"))]}),
        encoding="utf-8",
    )


class BootstrapYouGileTests(unittest.TestCase):
    def test_full_bootstrap_in_empty_git_repository(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            project_script = str(SCRIPT.with_name("bootstrap_project.py"))
            yougile_script = str(SCRIPT)
            subprocess.run(
                [sys.executable, project_script, "--target", str(target),
                 "--project-name", "Пример"],
                check=True, capture_output=True, text=True,
            )
            self.assertFalse((target / ".tasks/config.json").exists())
            subprocess.run(
                [sys.executable, project_script, "--target", str(target),
                 "--project-name", "Пример", "--apply"],
                check=True, capture_output=True, text=True,
            )
            subprocess.run(
                [sys.executable, yougile_script, "--target", str(target)],
                check=True, capture_output=True, text=True,
            )
            self.assertFalse((target / "tools/taskplanner-yougile-sync.mjs").exists())
            subprocess.run(
                [sys.executable, yougile_script, "--target", str(target), "--apply"],
                check=True, capture_output=True, text=True,
            )
            second = subprocess.run(
                [sys.executable, yougile_script, "--target", str(target), "--apply"],
                check=True, capture_output=True, text=True,
            )
            self.assertNotIn("WRITE", second.stdout)
            subprocess.run(
                [sys.executable, yougile_script, "--target", str(target), "--check"],
                check=True, capture_output=True, text=True,
            )

    def test_preview_is_offline_and_apply_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            prepare_board(target)
            (target / "AGENTS.md").write_text("# Existing\n", encoding="utf-8")
            actions, conflicts = bootstrap.planned_actions(target)
            self.assertFalse(conflicts)
            self.assertFalse((target / "tools").exists())
            self.assertTrue(any(path.name == "taskplanner-yougile-sync.mjs" for path, _ in actions))
            for path, content in actions:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            self.assertEqual(bootstrap.planned_actions(target), ([], []))
            self.assertIn("# Existing", (target / "AGENTS.md").read_text(encoding="utf-8"))
            self.assertIn("YOUGILE-SYNC:START", (target / "AGENTS.md").read_text(encoding="utf-8"))

    def test_customized_script_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            prepare_board(target)
            script = target / "tools" / "taskplanner-yougile-sync.mjs"
            script.parent.mkdir()
            script.write_text("// keep custom code\n", encoding="utf-8")
            _, conflicts = bootstrap.planned_actions(target)
            self.assertIn(str(script), conflicts)
            self.assertEqual(script.read_text(encoding="utf-8"), "// keep custom code\n")

    def test_requires_standard_board(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "TaskPlanner board is missing"):
                bootstrap.planned_actions(Path(directory))

    def test_installed_connector_can_preview_without_network_or_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            prepare_board(target)
            for path, content in bootstrap.planned_actions(target)[0]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            board = json.loads((target / ".tasks/config.json").read_text(encoding="utf-8"))
            for state in board["states"]:
                (target / ".tasks" / state["fileName"]).write_text("# Empty\n", encoding="utf-8")
            (target / ".tasks" / "BACKLOG.md").write_text(
                "# Backlog\n\n## TASK-001: Example\n\n**Priority:** P2\n**Estimate:** S\n\n---\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                ["node", str(target / "tools/taskplanner-yougile-sync.mjs"), "--workspace", str(target)],
                cwd=target,
                capture_output=True,
                text=True,
                check=True,
            )
            preview = json.loads(result.stdout)
            self.assertEqual(preview["mode"], "dry-run")
            self.assertEqual(preview["operations"][0]["taskId"], "TASK-001")
            self.assertIn("No external requests", preview["note"])
            (target / ".tasks" / "DONE.md").write_text(
                "# Done\n\n## TASK-002: Finished quickly\n\n**Priority:** P2\n**Created:** 2026-01-01 10:00\n**Started:** 2026-01-01 10:00\n**Completed:** 2026-01-01 11:00\n\n---\n",
                encoding="utf-8",
            )
            completed = subprocess.run(
                ["node", str(target / "tools/taskplanner-yougile-sync.mjs"),
                 "--workspace", str(target), "--task", "TASK-002"],
                cwd=target,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(json.loads(completed.stdout)["operations"][0]["taskId"], "TASK-002")


if __name__ == "__main__":
    unittest.main()
