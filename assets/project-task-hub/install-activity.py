"""Install local activity rules only; never configure or call YouGile."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--project', required=True, type=Path)
parser.add_argument('--home', type=Path)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
hub = Path(__file__).resolve().parent
home = args.home.resolve() if args.home else hub / '.local'
root = args.project.resolve(strict=True)
if not (root / '.tasks/config.json').is_file():
    raise SystemExit('An existing task board is required.')
helper = root / 'tools/project-task-hub.mjs'
asset = (hub / 'assets/project-task-hub.mjs').read_bytes()
if helper.exists() and helper.read_bytes() != asset:
    raise SystemExit('Customized activity helper preserved; review required.')
rules = '''\n<!-- PROJECT-ACTIVITY:START -->
## Журнал работы и отчёты

- Завершение задачи фиксируй в Done, с фактической датой Completed и кратким WORK_LOG; общий Hub читает их автоматически.
- Для значимого исследования, решения или блокера без завершения задачи сохраняй короткий подтверждённый итог: `node tools/project-task-hub.mjs log --kind research --summary "Итог" --apply` (при необходимости --task TASK-ID). Для сложного текста — --file с локальным JSON. Не включай секреты, персональные данные и приватные ссылки.
- Отчёт по проекту: `node tools/project-task-hub.mjs report --period week`; доступны day/month, --date, --from/--to. Для всех проектов используй CLI общего Hub с --project all.
- При подключённом YouGile и включённой политике passports Hub создаёт docs/project-passport.md. При изменении публичных ссылок, назначения, интеграций или эксплуатации обнови подтверждённые факты в паспорте с датой и источником; не копируй секреты и приватные адреса. Затем выполни `node tools/project-task-hub.mjs passport --refresh --apply`. Если publisherEnabled=true, обработай этот паспорт по PASSPORT-WORKER.md из папки Hub в локальном указателе; существующую страницу и ручные дополнения сохраняй. Часовая проверка подхватывает пропуски. Без YouGile эти правила не создают удалённых страниц.
- Локальный указатель .tasks/project-task-hub.local.json исключён из Git; без него общий журнал недоступен. Эти правила не подключают проект к YouGile.
<!-- PROJECT-ACTIVITY:END -->
'''
profiles = [root / name for name in ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] if (root / name).exists()]
print(json.dumps(dict(mode='apply' if args.apply else 'preview', project=str(root), agentProfiles=len(profiles), taskFilesModified=0, remoteWrites=0), ensure_ascii=False))
if args.apply:
    backup = home / 'backups/activity' / hashlib.sha256(str(root).encode()).hexdigest()[:20]
    backup.mkdir(parents=True, exist_ok=True)
    for path in [helper, root / '.gitignore', *profiles]:
        if path.exists() and not (backup / path.name).exists(): shutil.copyfile(path, backup / path.name)
    helper.parent.mkdir(parents=True, exist_ok=True)
    if not helper.exists(): helper.write_bytes(asset)
    pointer = root / '.tasks/project-task-hub.local.json'
    pointer.write_text(json.dumps(dict(schemaVersion=1, cli=str(hub / 'cli.mjs'), home=str(home)), indent=2) + '\n', encoding='utf-8')
    block = re.compile(rb'\n?<!-- PROJECT-ACTIVITY:START -->.*?<!-- PROJECT-ACTIVITY:END -->\r?\n?', re.S)
    for path in profiles:
        original = path.read_bytes()
        updated = block.sub(lambda _: rules.encode(), original, count=1) if block.search(original) else original + rules.encode()
        if updated != original: path.write_bytes(updated)
    ignore = root / '.gitignore'
    original = ignore.read_bytes() if ignore.exists() else b''
    line = b'.tasks/project-task-hub.local.json'
    if line not in original.splitlines(): ignore.write_bytes(original + (b'' if original.endswith(b'\n') else b'\n') + line + b'\n')
