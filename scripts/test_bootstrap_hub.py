from __future__ import annotations
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import bootstrap_hub as hub


class HubBootstrapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='portable-hub-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.projects = self.base / 'projects'
        self.projects.mkdir()
        self.profile = self.projects / 'existing'
        (self.profile / '.tasks').mkdir(parents=True)
        self.key = self.base / 'private-key.txt'
        self.key.write_text('fixture-not-a-real-key', encoding='utf-8')
        self.config = dict(baseUrl='https://yougile.com/api-v2', workspaceKey='fixture', projectId='project', boardId='board', columns={'Backlog': 'col'}, apiKeyFile=str(self.key))
        (self.profile / '.tasks/yougile.local.json').write_text(json.dumps(self.config), encoding='utf-8')
        (self.profile / '.tasks/config.json').write_text('{"states": []}', encoding='utf-8')
        old = self.projects / 'old-unconfigured'
        (old / '.tasks').mkdir(parents=True)
        (old / '.tasks/config.json').write_text('{"states": []}', encoding='utf-8')
        self.runtime = self.base / 'runtime'
        self.pointer = self.base / 'codex/project-task-hub.json'
        self.arguments = ['--hub-root', str(self.runtime), '--root', str(self.projects), '--profile-from', str(self.profile), '--pointer', str(self.pointer)]

    def run_setup(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return hub.main(self.arguments + list(extra))

    def test_preview_is_offline_and_writes_nothing(self):
        self.assertEqual(self.run_setup(), 0)
        self.assertFalse(self.runtime.exists())
        self.assertFalse(self.pointer.exists())

    def test_install_preserves_profiles_and_seeds_exclusions_only_once(self):
        before = (self.profile / '.tasks/yougile.local.json').read_bytes()
        self.assertEqual(self.run_setup('--apply'), 0)
        settings = hub.read_json(self.runtime / '.local/settings.json')
        registry = hub.read_json(self.runtime / '.local/registry.json')
        old_id = next(p['id'] for p in registry['projects'] if p['name'] == 'old-unconfigured')
        self.assertEqual(settings['autoOnboarding']['excludedProjectIds'], [old_id])
        self.assertEqual(settings['discoveryIntervalMs'], 3600000)
        self.assertEqual((self.profile / '.tasks/yougile.local.json').read_bytes(), before)
        new = self.projects / 'created-later'
        (new / '.tasks').mkdir(parents=True)
        (new / '.tasks/config.json').write_text('{"states": []}', encoding='utf-8')
        self.assertEqual(self.run_setup('--apply'), 0)
        self.assertEqual(hub.read_json(self.runtime / '.local/settings.json')['autoOnboarding']['excludedProjectIds'], [old_id])
        # The runtime contains a key-file reference only, never the key bytes.
        for path in self.runtime.rglob('*'):
            if path.is_file():
                self.assertNotIn(b'fixture-not-a-real-key', path.read_bytes())

    def test_customized_runtime_and_other_hub_pointer_are_preserved(self):
        self.assertEqual(self.run_setup('--apply'), 0)
        cli = self.runtime / 'cli.mjs'
        cli.write_text('// custom owner change\n', encoding='utf-8')
        self.assertEqual(self.run_setup('--apply'), 2)
        self.assertEqual(cli.read_text(encoding='utf-8'), '// custom owner change\n')
        cli.write_bytes((hub.BUNDLE / 'cli.mjs').read_bytes())
        hub.atomic_json(self.pointer, {'home': str(self.base / 'other/.local')})
        self.assertEqual(self.run_setup('--apply'), 2)
        self.assertEqual(hub.read_json(self.pointer)['home'], str(self.base / 'other/.local'))

    def test_project_bootstrap_invokes_hook_without_live_api(self):
        # A real bootstrap + hook + fake CLI verifies event-based integration, no API involved.
        cli = self.base / 'fake.mjs'
        called = self.base / 'called.json'
        cli.write_text('import fs from "node:fs";fs.writeFileSync(' + json.dumps(str(called)) + ',JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({action:"connected"}));', encoding='utf-8')
        hub.atomic_json(self.pointer, dict(enabled=True, node=hub.shutil.which('node'), cli=str(cli), home=str(self.runtime / '.local')))
        project = self.projects / 'new-project'
        project.mkdir()
        subprocess.run(['git', 'init', '-q', str(project)], check=True, capture_output=True)
        command = [sys.executable, str(Path(__file__).with_name('bootstrap_project.py')), '--target', str(project), '--taskplanner-version', '2.3.0']
        env = {**os.environ, 'PROJECT_TASK_HUB_POINTER': str(self.pointer)}
        preview = subprocess.run(command, check=True, capture_output=True, text=True, encoding='utf-8', env=env)
        self.assertFalse(called.exists())
        self.assertFalse((project / '.tasks').exists())
        applied = subprocess.run(command + ['--apply'], check=True, capture_output=True, text=True, encoding='utf-8', env=env)
        self.assertIn('YouGile: connected', applied.stdout)
        self.assertEqual(hub.read_json(called)[0], 'onboard')
        before = {p.relative_to(project): p.read_bytes() for p in project.rglob('*') if p.is_file() and '.git' not in p.parts}
        subprocess.run(command + ['--apply'], check=True, capture_output=True, env=env)
        self.assertEqual(before, {p.relative_to(project): p.read_bytes() for p in project.rglob('*') if p.is_file() and '.git' not in p.parts})
        subprocess.run(command + ['--check'], check=True, capture_output=True, env=env)

    def test_failed_hook_does_not_undo_project_bootstrap_or_echo_secrets(self):
        cli = self.base / 'failure.mjs'
        cli.write_text('console.error("fixture-private-response");process.exit(1)', encoding='utf-8')
        hub.atomic_json(self.pointer, dict(enabled=True, node=hub.shutil.which('node'), cli=str(cli), home=str(self.runtime / '.local')))
        project = self.projects / 'offline-project'
        project.mkdir()
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('bootstrap_project.py')), '--target', str(project), '--apply'],
                                capture_output=True, text=True, encoding='utf-8', env={**os.environ, 'PROJECT_TASK_HUB_POINTER': str(self.pointer)})
        self.assertEqual(result.returncode, 0)
        self.assertTrue((project / '.tasks/config.json').exists())
        self.assertIn('pending', result.stdout)
        self.assertNotIn('fixture-private-response', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
