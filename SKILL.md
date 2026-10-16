---
name: project-task-system
description: Initialize or audit a repository-wide project operating system with a Git-tracked TaskPlanner board, managed agent profiles, and lightweight product, architecture, decision, integration, deployment, and current-work documents. Optionally configure a shared YouGile hub with project-onboarding hooks and hourly fallback, or install a standalone connector. Use for bootstrapping a project, adding this workflow safely, or generating project-work activity reports.
---

# Project Task System

Create a portable project-management layer without coupling it to a particular product, stack, host, or deployment provider.

## Workflow

1. Resolve the repository root and inspect existing `.tasks/`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `docs/`, and Git status.
2. If the TaskPlanner plugin is available, prefer its initializer for the board. Never downgrade a board whose `taskplannerVersion` is newer than the installed plugin.
3. Preview the bundled bootstrap before applying it:

   ```bash
   python scripts/bootstrap_project.py --target <repository> --project-name "<name>"
   ```

4. Apply only after checking the preview. If the user previously enabled a local hub policy, this also connects the project inside its approved roots:

   ```bash
   python scripts/bootstrap_project.py --target <repository> --project-name "<name>" --apply
   ```

5. Adapt newly created documents to the actual project. Replace examples with confirmed commands and facts; do not invent architecture, integrations, deployment commands, or verification results.
6. Validate the installed system with `--check`, then report created, updated, and preserved files separately.

The bootstrap is additive by default. It does not overwrite an existing TaskPlanner board or existing project documents. It can append missing managed blocks to agent profiles. Use `--refresh-managed` only when the user explicitly wants the skill-owned profile blocks synchronized.

## Required and optional tooling

- TaskPlanner is recommended for native board commands and UI, but the bundled files remain usable without MCP access.
- Git is required only when the user wants version history or publication.
- GitHub CLI or a GitHub connector is optional and is used only after the user explicitly requests publication.

Do not install plugins, create repositories, commit, push, deploy, or modify remote state merely because the skill was invoked. Obtain or rely on explicit authorization for those operations.

## Optional shared YouGile setup

For cross-project discovery, connection at project creation, or hourly retry, read
[references/yougile-hub.md](references/yougile-hub.md). Use the bundled
`scripts/bootstrap_hub.py` to install a persistent runtime outside this skill.
The user chooses approved roots and an existing company profile once. Enable
remote onboarding and the OS schedule only within that authorized scope.

Normal bootstrap reads `project-task-hub.json` in `CODEX_HOME` (default
`~/.codex`). Without an enabled pointer it behaves as before. With a previously
authorized policy, run the usual preview/apply workflow: the post-apply hook
preserves existing connections or provisions a new board. Do not reinstall a
standalone connector over a hub bridge or request the same approval/key again.
Report pending connection on failure; hourly fallback retries inside approved
roots. Task edits still require the immediate sync command in project rules.

Keep responsibilities separate: REST API synchronizes managed tasks from `.tasks`;
official YouGile MCP publishes knowledge-base passports after semantic review.
An hourly script checks pending work without a model; invoke Codex only for a
nonempty authorized passport queue. Read [how it works](references/how-it-works.ru.md)
when explaining or configuring this split. Do not bypass the local task source
by editing managed task fields through MCP.

## Resources

- Read [references/installation.md](references/installation.md) when installing the skill or publishing it for reuse.
- Read [references/template-contract.md](references/template-contract.md) before changing the generated file set or merge behavior.
- Read [references/yougile.md](references/yougile.md) when the user asks to connect, install, or monitor TaskPlanner tasks in YouGile. This is an optional second phase after the TaskPlanner board is present; preview before applying and never reuse another user's key or IDs.
- Use the files under `assets/project-template/` as output templates, not as additional instructions.

## Work journals, reports and project passports

For a work report by day/week/month, a cross-project overview, a significant-work
journal or a project passport, read [references/activity-reports.md](references/activity-reports.md).
Locate the enabled local hub pointer and use its CLI. Do not initialize boards or
change YouGile destinations just to produce a report. Default reports cover all
registered projects; pass the requested project explicitly when scoped. State the
actual calendar interval and coverage gaps; never infer hours from task estimates.
After non-task research/decisions/blockers, record a short confirmed note through
`log`; Done and WORK_LOG are collected automatically. Maintain `docs/project-passport.md` when public links or confirmed operating facts
change. Hub 0.6 creates a draft on onboarding and queues important-document changes. Publish through official YouGile MCP with OAuth, reviewed Markdown, stable page IDs, conflict checks and readback; see PASSPORT-WORKER.md. Keep one hourly script fallback.
When automatic passport publication is authorized and enabled locally, follow the
runtime PASSPORT-WORKER.md to update the existing YouGile knowledge-base page,
preserve manual additions, verify by MCP readback and acknowledge the source revision.
For conditional publication, let the hourly OS tick inspect pending work without AI
and use codex queue only when it is nonempty. Configure passports.wake for an
existing chat; pause the unconditional heartbeat through automation_update.
Preserve start/finish receipts and duplicate protection. Do not claim publication
from an HTML export.
