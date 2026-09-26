# Система задач для проектов

Готовый навык Codex для установки TaskPlanner в новый или существующий репозиторий. Он добавляет доску задач в Git, правила работы для ИИ-агентов и компактную проектную документацию. Подключение YouGile — отдельный необязательный шаг.

## Что устанавливается

| Часть | Файлы | Назначение |
| --- | --- | --- |
| Доска задач | `.tasks/BACKLOG.md`, `NEXT.md`, `IN_PROGRESS.md`, `DONE.md`, `REJECTED.md` | Задачи и статусы, видимые в Git |
| Настройки и история | `.tasks/config.json`, `.tasks/WORK_LOG.md` | Нумерация задач, приоритеты и журнал завершений |
| Правила для агентов | `AGENTS.md`, `CLAUDE.md`, `.cursorrules` | Единый порядок работы для Codex, Claude и Cursor |
| Контекст проекта | `docs/*.md` | Продукт, архитектура, интеграции, решения, качество и текущая работа |
| Шаблон PR | `.github/pull_request_template.md` | Проверка изменений перед объединением |

TaskPlanner рекомендуется как плагин, но доска состоит из обычных Markdown- и JSON-файлов и работает без него. Шаблон новой доски рассчитан на TaskPlanner `2.1.4`; установленную у вас версию можно передать через `--taskplanner-version`. Существующая доска не перезаписывается и не понижается.

## Установка

Попросите Codex:

```text
Установи навык через $skill-installer из https://github.com/neuro-boss/project-task-system
```

Затем откройте нужный проект и попросите: «Используй `$project-task-system`, чтобы настроить систему задач в этом репозитории». При желании установите плагин TaskPlanner из каталога Codex для встроенных команд доски.

Можно запустить установщик из клона этого репозитория вручную. Первая команда только показывает план и ничего не записывает:

```bash
python scripts/bootstrap_project.py --target /path/to/project --project-name "Мой проект"
python scripts/bootstrap_project.py --target /path/to/project --project-name "Мой проект" --apply
python scripts/bootstrap_project.py --target /path/to/project --check
```

Существующие задачи и документы сохраняются. Управляемые блоки правил агента обновляются только при явном `--refresh-managed`.

## Необязательное подключение YouGile

После установки TaskPlanner можно добавить локальную одностороннюю синхронизацию задач в собственную компанию YouGile. Доска `.tasks/*.md` остаётся главным источником; ключ, рабочие ID и карта соответствий хранятся локально вне Git. Установщик не вызывает API и не создаёт удалённые объекты.

```bash
python scripts/bootstrap_yougile.py --target /path/to/project
python scripts/bootstrap_yougile.py --target /path/to/project --apply
python scripts/bootstrap_yougile.py --target /path/to/project --check
```

Дальше следуйте [инструкции подключения YouGile](references/yougile.md). Для передачи другому ИИ есть [готовый промпт на русском](references/yougile-prompt.ru.txt). Ключ своей компании нельзя отправлять в чат или добавлять в репозиторий. Автоматический фоновый мониторинг установщик не включает.

## Проверка и безопасность

Установщики сначала показывают изменения и сохраняют существующие пользовательские файлы. Перед публикацией своего проекта проверьте, что локальные настройки и ключи не отслеживаются Git. Тесты этого репозитория:

```bash
python -m unittest discover -s scripts
node --test assets/yougile/taskplanner-yougile-core.test.mjs
```

## Лицензия

MIT
