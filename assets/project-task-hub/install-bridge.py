"""Preview/apply a narrowly bounded bridge; never change existing task content."""
import argparse
import hashlib
import json
import pathlib
import shutil
import re
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--project', required=True)
parser.add_argument('--apply', action='store_true')
parser.add_argument('--home')
args = parser.parse_args()
hub = pathlib.Path(__file__).resolve().parent
home = pathlib.Path(args.home).resolve() if args.home else hub / '.local'
root = pathlib.Path(args.project).resolve(strict=True)
source = root / 'tools' / 'taskplanner-yougile-sync.mjs'
original = source.read_bytes()
start = '// PROJECT-TASK-HUB:START'
end = '// PROJECT-TASK-HUB:END'
prelude = f"{start}\nimport {{ routeToHub }} from './taskplanner-yougile-hub.mjs';\nawait routeToHub(import.meta.url);\n{end}\n"
text = original.decode('utf-8')
if start in text and prelude not in text:
    raise SystemExit('Existing managed bridge differs; preserved for review.')
bridge = root / 'tools' / 'taskplanner-yougile-hub.mjs'
bridge_bytes = (hub / 'assets' / bridge.name).read_bytes()
previous_bridge_hashes = {'b7fe2f35fc11a2280e9431907167422bddecc45b820595d58a64a28dfe23aa04', '2244af7bd70529a215ba6cb361a9159d971672fad74a50c9fb26ded55cc763df'}
if bridge.exists() and bridge.read_bytes() != bridge_bytes and hashlib.sha256(bridge.read_bytes()).hexdigest() not in previous_bridge_hashes:
    raise SystemExit('Existing customized bridge preserved; review required.')
profiles = [root / n for n in ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] if (root / n).exists()]
rules = '''\n<!-- PROJECT-TASK-HUB:START -->
## Общая синхронизация YouGile

- Этот проект обслуживается локальным Project Task Hub. `.tasks` остаётся источником задач.
- После каждого изменения задачи запускай `node tools/taskplanner-yougile-sync.mjs --apply --task TASK-ID`: локальный мост направит запись через общую очередь и блокировку. Фоновая проверка раз в час подхватывает пропуски.
- Не меняй workspaceKey, текущие ID доски или карту карточек ради повторного подключения. Не удаляй карту после сетевой ошибки.
- Служебный указатель `.tasks/yougile.hub.local.json` локален и исключён из Git. Без него исходный коннектор сохраняет самостоятельную работу.
- Старые Done/Rejected не импортируются фоном. Ошибка синхронизации не отменяет изменение локальной задачи.
- Значимые исследования, решения и блокеры без перехода задачи записывай кратко: `node tools/taskplanner-yougile-hub.mjs log --kind research --summary "Короткий подтверждённый итог" --task TASK-ID --apply`. Для сложного текста используй `--file путь-к-локальному-JSON`. Не записывай ключи, персональные данные и приватные ссылки.
- Не дублируй запись о Done вручную: WORK_LOG и фактические даты автоматически попадают в журнал. Отчёт: `node tools/taskplanner-yougile-hub.mjs report --period week` (также day/month, --date или --from/--to).
- Если есть `docs/project-passport.md`, обновляй его при изменении публичных ссылок, интеграций и правил работы; отмечай источник и дату проверки. Не заменяй неизвестное догадкой.
<!-- PROJECT-TASK-HUB:END -->
'''
changes = ['local ignored hub pointer', 'add optional route before original connector', 'add bridge module', 'append missing agent rule block', 'append ignore rule']
print(json.dumps({'project': str(root), 'mode': 'apply' if args.apply else 'preview', 'changes': changes, 'taskFilesModified': 0}, ensure_ascii=False))
if args.apply:
    backup = home / 'backups' / hashlib.sha256(str(root).encode()).hexdigest()[:20]
    backup.mkdir(parents=True, exist_ok=True)
    for path in [source, bridge, root / '.gitignore', *profiles]:
        if path.exists():
            dest = backup / path.name
            if not dest.exists():
                shutil.copyfile(path, dest)
    pointer = {'schemaVersion': 1, 'enabled': True, 'cli': str(hub / 'cli.mjs'), 'home': str(home)}
    (root / '.tasks' / 'yougile.hub.local.json').write_text(json.dumps(pointer, indent=2) + '\n', encoding='utf-8')
    if not bridge.exists() or bridge.read_bytes() != bridge_bytes:
        bridge.write_bytes(bridge_bytes)
    if start not in text:
        source.write_bytes(prelude.encode() + original)
    for path in profiles:
        existing = path.read_bytes()
        block = re.compile(rb'\n?<!-- PROJECT-TASK-HUB:START -->.*?<!-- PROJECT-TASK-HUB:END -->\r?\n?', re.S)
        path.write_bytes(block.sub(lambda _: rules.encode('utf-8'), existing, count=1) if block.search(existing) else existing + rules.encode('utf-8'))
    note = '''\n<!-- PROJECT-TASK-HUB:START -->
## Фоновая синхронизация задач — 2026-10-15

Проект подключён к локальному Project Task Hub. На компьютере владельца скрытая
задача Windows раз в час подхватывает пропущенные изменения и новые проекты; задачи остаются источником истины,
а YouGile — односторонним отображением. Существующие задачи и связи сохранены.
Исторические Done/Rejected автоматически не импортируются. Прежний запуск
`node tools/taskplanner-yougile-sync.mjs --apply --task TASK-ID` проходит через
общую очередь благодаря локальному указателю `.tasks/yougile.hub.local.json`,
исключённому из Git. Ошибки не отменяют локальные изменения; повтор использует те
же ID. Проектный runtime приложения и production этим подключением не менялись.
<!-- PROJECT-TASK-HUB:END -->
'''
    for filename in ['current-task.md', 'integrations.md']:
        path = root / 'docs' / filename
        if path.exists():
            existing = path.read_bytes()
            dest = backup / ('docs-' + filename)
            if not dest.exists():
                shutil.copyfile(path, dest)
            block = re.compile(rb'\n?<!-- PROJECT-TASK-HUB:START -->.*?<!-- PROJECT-TASK-HUB:END -->\r?\n?', re.S)
            path.write_bytes(block.sub(lambda _: note.encode('utf-8'), existing, count=1) if block.search(existing) else existing + note.encode('utf-8'))
    ignore = root / '.gitignore'
    existing = ignore.read_bytes() if ignore.exists() else b''
    rule = b'.tasks/yougile.hub.local.json'
    if rule not in existing.splitlines():
        ignore.write_bytes(existing + (b'' if existing.endswith(b'\n') else b'\n') + rule + b'\n')
