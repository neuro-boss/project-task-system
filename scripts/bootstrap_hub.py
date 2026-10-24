#!/usr/bin/env python3
"""Install an opt-in shared YouGile hub without copying keys or replacing boards."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

BUNDLE = Path(__file__).resolve().parents[1] / 'assets/project-task-hub'


class SetupError(ValueError):
    """Only deliberate, non-sensitive diagnostics may be printed."""


def read_json(path: Path, fallback=None):
    if not path.exists() and fallback is not None:
        return fallback
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.hub-setup.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def default_pointer() -> Path:
    return Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'project-task-hub.json'


def prepare(args):
    root = args.hub_root.expanduser().resolve()
    if root == BUNDLE or BUNDLE in root.parents:
        raise SetupError('Choose a persistent runtime directory outside the bundled skill assets.')
    roots = [str(p.expanduser().resolve(strict=True)) for p in args.root]
    if not all(Path(p).is_dir() for p in roots):
        raise SetupError('Approved roots must be directories.')
    profile = args.profile_from.expanduser().resolve(strict=True)
    config = read_json(profile / '.tasks/yougile.local.json')
    if not all(config.get(k) for k in ['baseUrl', 'workspaceKey', 'projectId', 'boardId', 'columns']):
        raise SetupError('Select an existing configured YouGile project as the company profile.')
    key = (profile / config.get('apiKeyFile', '.tasks/yougile.api-key.txt')).resolve()
    if not key.is_file():
        raise SetupError('The approved company profile needs an existing API key file. Do not paste the key into commands.')
    node = shutil.which('node')
    if not node:
        raise SetupError('Node.js 20+ is required.')
    check = subprocess.run([node, '-p', 'Number(process.versions.node.split(".")[0]) >= 20'], capture_output=True, text=True, check=True)
    if check.stdout.strip() != 'true':
        raise SetupError('Node.js 20+ is required.')
    if args.schedule and sys.platform != 'win32':
        raise SetupError('--schedule currently installs Windows Task Scheduler; use your OS scheduler for hourly tick on other systems.')
    home = root / '.local'
    settings = read_json(home / 'settings.json', {})
    settings.update(schemaVersion=1, roots=list(dict.fromkeys(roots)), scanDepth=settings.get('scanDepth', 4), discoveryIntervalMs=3600000)
    settings.setdefault('minRequestIntervalMs', 2000)
    settings.setdefault('maxWritesPerProject', 30)
    # Creating a local draft/queue is separate from authorizing an MCP publisher.
    settings.setdefault('passports', {'enabled': True})
    policy = settings.setdefault('autoOnboarding', {})
    policy.update(enabled=True, roots=settings['roots'], profileFrom=str(profile), assets=str(root / 'vendor/yougile'), python=sys.executable)
    policy.setdefault('savedProjects', {'enabled': True, 'binary': 'auto'})
    pointer = args.pointer.expanduser().resolve()
    old_pointer = read_json(pointer, {})
    if old_pointer and Path(old_pointer.get('home', '')).resolve() != home and not args.replace_pointer:
        raise SetupError('A different hub pointer already exists. Preserve it, or explicitly select --replace-pointer after reviewing the switch.')
    owned = read_json(home / 'installed-files.json', {}).get('files', {})
    files = {}
    for source in BUNDLE.rglob('*'):
        if not source.is_file() or '__pycache__' in source.parts or source.suffix == '.pyc':
            continue
        name = source.relative_to(BUNDLE).as_posix()
        if name.startswith('test/'):
            continue
        destination = root / name
        data = source.read_bytes()
        if destination.exists() and destination.read_bytes() != data and digest(destination.read_bytes()) != owned.get(name):
            raise SetupError('Customized runtime file preserved; review before upgrading: ' + name)
        files[name] = data
    # Standalone runtime can initialize a newly saved Codex project without the skill installed.
    template = BUNDLE.parent / 'project-template'
    for source in template.rglob('*'):
        if not source.is_file() or source.relative_to(template).parts[0] == '.github':
            continue
        name = 'project-template/' + source.relative_to(template).as_posix()
        destination = root / name
        data = source.read_bytes()
        if destination.exists() and destination.read_bytes() != data and digest(destination.read_bytes()) != owned.get(name):
            raise SetupError('Customized project template preserved; review before upgrading: ' + name)
        files[name] = data
    return root, home, pointer, node, settings, files


def install(args) -> int:
    root, home, pointer, node, settings, files = prepare(args)
    task_name = 'ProjectTaskHub-' + digest(str(root).encode())[:10]
    print(json.dumps(dict(mode='apply' if args.apply else 'preview', hub=str(root), pointer=str(pointer), roots=settings['roots'], intervalMinutes=60,
                         windowsSchedule=bool(args.schedule), taskName=task_name, runtimeFiles=len(files), existingBoardsPreserved=True, credentialsCopied=False), ensure_ascii=False))
    if not args.apply:
        return 0
    backup = home / 'backups' / ('setup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f'))
    backup.mkdir(parents=True)
    for index, path in enumerate([home / 'settings.json', home / 'installed-files.json', pointer]):
        if path.exists():
            shutil.copyfile(path, backup / f'{index}-{path.name}')
    for name, data in files.items():
        destination = root / name
        if destination.exists() and destination.read_bytes() == data:
            continue
        if destination.exists():
            saved = backup / 'runtime' / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(destination, saved)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.hub-setup.tmp')
        temporary.write_bytes(data)
        temporary.replace(destination)
    atomic_json(home / 'settings.json', settings)
    # Scan is offline. Never silently create boards for all old, unconfigured projects.
    scanned = subprocess.run([node, str(root / 'cli.mjs'), 'scan', '--home', str(home)], capture_output=True, text=True, encoding='utf-8')
    if scanned.returncode:
        print('Offline discovery failed; no hook or schedule was enabled. Inspect the runtime settings.', file=sys.stderr)
        return 1
    registry = read_json(home / 'registry.json')
    for project in registry['projects']:
        target = Path(project['path']).resolve()
        if not any(target != Path(folder) and target.is_relative_to(Path(folder)) for folder in settings['roots']):
            continue
        activity = subprocess.run([sys.executable, str(root / 'install-activity.py'), '--project', str(target), '--home', str(home), '--apply'], capture_output=True)
        if activity.returncode:
            print('Activity rule conflict; original project files preserved. Resolve before enabling the hook/schedule.', file=sys.stderr)
            return 1
    settings['autoOnboarding'].setdefault('excludedProjectIds', [p['id'] for p in registry['projects'] if not p['enabled'] and not p['configured']])
    atomic_json(home / 'settings.json', settings)
    # Metadata RPC only; no inference or YouGile writes. Baseline before future projects appear.
    if settings['autoOnboarding'].get('savedProjects', {}).get('enabled'):
        try:
            subprocess.run([node, str(root / 'cli.mjs'), 'discover-saved', '--home', str(home), '--apply'], capture_output=True, timeout=60)
        except subprocess.TimeoutExpired:
            print('Saved Codex project inventory unavailable; the first successful hourly discovery will establish its baseline.')
    atomic_json(home / 'installed-files.json', dict(schemaVersion=1, files={name: digest(data) for name, data in files.items()}))
    atomic_json(pointer, dict(schemaVersion=1, enabled=True, node=node, cli=str(root / 'cli.mjs'), home=str(home)))
    if args.schedule:
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(root / 'windows/install-startup.ps1'), '-TaskName', task_name, '-Apply'], check=True)
    print('Hub ready. New project bootstrap connects within approved roots; hourly tick retries missed setup. Existing unconfigured projects stay excluded.')
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hub-root', required=True, type=Path, help='Persistent runtime directory outside the skill installation')
    parser.add_argument('--root', required=True, action='append', type=Path, help='Approved projects directory; repeat for multiple roots')
    parser.add_argument('--profile-from', required=True, type=Path, help='Existing configured project in the company authorized by the user')
    parser.add_argument('--pointer', type=Path, default=default_pointer(), help='Local hook pointer (defaults to CODEX_HOME/project-task-hub.json)')
    parser.add_argument('--schedule', action='store_true', help='Install a hidden hourly Windows task and run its first tick')
    parser.add_argument('--replace-pointer', action='store_true', help='Explicitly replace a pointer to a different hub')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        return install(args)
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 2
    except (OSError, ValueError, subprocess.SubprocessError):
        # Local configs and child stderr can contain secrets: keep detailed responses out of logs.
        print('Hub setup could not complete. Check paths, Node 20+, approved profile/key file, runtime conflicts and existing pointer. Existing project boards were preserved.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
