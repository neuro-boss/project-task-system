from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("bootstrap_project.py")
SPEC = importlib.util.spec_from_file_location("bootstrap_project", SCRIPT)
assert SPEC and SPEC.loader
bootstrap = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bootstrap
SPEC.loader.exec_module(bootstrap)


class BootstrapProjectTests(unittest.TestCase):
    def test_preview_does_not_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            actions = bootstrap.build_actions(target, "Example", "2.1.1")
            self.assertTrue(any(action.kind == "create" for action in actions))
            self.assertEqual(list(target.iterdir()), [])

    def test_apply_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            first = bootstrap.build_actions(target, "Example", "2.1.1")
            bootstrap.apply_actions(first)
            self.assertEqual(bootstrap.check_system(target), [])

            second = bootstrap.build_actions(target, "Example", "2.1.1")
            self.assertFalse(
                any(action.kind in {"create", "update"} for action in second)
            )

    def test_existing_content_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            agents = target / "AGENTS.md"
            product = target / "docs" / "product.md"
            product.parent.mkdir(parents=True)
            agents.write_text("# Existing rules\n\nKeep me.\n", encoding="utf-8")
            product.write_text("# Existing product\n", encoding="utf-8")

            actions = bootstrap.build_actions(target, "Example", "2.1.1")
            bootstrap.apply_actions(actions)

            self.assertIn("Keep me.", agents.read_text(encoding="utf-8"))
            self.assertEqual(
                product.read_text(encoding="utf-8"), "# Existing product\n"
            )
            self.assertIn(
                "<!-- TASKPLANNER:START -->", agents.read_text(encoding="utf-8")
            )

    def test_existing_board_is_not_rewritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            config = target / ".tasks" / "config.json"
            config.parent.mkdir(parents=True)
            original = '{"version": 2, "states": []}\n'
            config.write_text(original, encoding="utf-8")

            actions = bootstrap.build_actions(target, "Example", "2.1.1")
            bootstrap.apply_actions(actions)

            self.assertEqual(config.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
