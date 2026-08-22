# Project Task System

A reusable Codex skill for adding a Git-tracked TaskPlanner board, agent instructions, and a compact project-documentation backbone to a new or existing repository.

## What it installs

| Area               | Files                                                                      | Purpose                                                                               |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Task board         | `.tasks/BACKLOG.md`, `NEXT.md`, `IN_PROGRESS.md`, `DONE.md`, `REJECTED.md` | Visible task flow stored in Git                                                       |
| Task settings      | `.tasks/config.json`                                                       | IDs, priorities, states, insertion and planning rules                                 |
| Completion history | `.tasks/WORK_LOG.md`                                                       | Short durable summaries of completed work                                             |
| Agent profiles     | `AGENTS.md`, `CLAUDE.md`, `.cursorrules`                                   | Shared working rules across Codex, Claude, and Cursor                                 |
| Project context    | `docs/*.md`                                                                | Current work, product, architecture, integrations, decisions, deployment, and quality |
| Pull requests      | `.github/pull_request_template.md`                                         | Consistent verification and documentation checklist                                   |

TaskPlanner is the only recommended plugin. New boards currently record compatibility with TaskPlanner `2.1.4`; a different installed version can be supplied explicitly with `--taskplanner-version`. The files are deliberately plain Markdown and JSON, so the workflow still works if the plugin or its MCP tools are unavailable.

## Use

Invoke the installed skill:

```text
Use $project-task-system to initialize this repository.
```

Or run the bootstrap directly. The first command is a preview and does not write:

```bash
python scripts/bootstrap_project.py --target /path/to/repository --project-name "My Project"
python scripts/bootstrap_project.py --target /path/to/repository --project-name "My Project" --apply
python scripts/bootstrap_project.py --target /path/to/repository --check
```

Existing boards and documents are preserved. Managed profile blocks are refreshed only with `--refresh-managed`.

## Install

Ask Codex:

```text
Use $skill-installer to install the skill from https://github.com/neuro-boss/project-task-system
```

Alternatively, copy this repository to your personal Codex skills directory under the name `project-task-system`. Install the TaskPlanner plugin separately from the Codex plugin catalog when native board commands are desired.

## License

MIT
