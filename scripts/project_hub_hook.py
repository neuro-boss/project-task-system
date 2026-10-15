"""Optional local opt-in hook. Contains no user-specific paths or credentials."""
import json
import os
from pathlib import Path
import subprocess


def run_hub_hook(target: Path, applying: bool) -> None:
    pointer = Path(os.environ.get('PROJECT_TASK_HUB_POINTER', str(Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'project-task-hub.json')))
    if not pointer.exists():
        return
    try:
        config = json.loads(pointer.read_text(encoding='utf-8-sig'))
        if not config.get('enabled'):
            return
        if not applying:
            print('YouGile: local opt-in enabled; after apply, the hub checks its approved roots and preserves existing connections.')
            return
        result = subprocess.run(
            [config['node'], config['cli'], 'onboard', '--home', config['home'], '--project', str(target), '--apply'],
            shell=False, capture_output=True, text=True, encoding='utf-8', timeout=180,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        if result.returncode:
            print('YouGile: connection pending; hourly discovery retries setup. Local project files were installed.')
        else:
            report = json.loads(result.stdout)
            print('YouGile: ' + report.get('action', 'checked'))
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        # Do not echo output or exceptions which could contain private service responses.
        print('YouGile: local hook unavailable; hourly discovery retries projects inside approved roots.')
