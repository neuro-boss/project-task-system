---
name: project-task-system
description: Initialize or audit a repository-wide project operating system with a Git-tracked TaskPlanner board, managed agent profiles, and lightweight product, architecture, decision, integration, deployment, and current-work documents. Optionally install the local TaskPlanner-to-YouGile connector. Use for bootstrapping a new project or adding the same workflow safely to an existing repository.
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

4. Apply only after checking the preview:

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

## Resources

- Read [references/installation.md](references/installation.md) when installing the skill or publishing it for reuse.
- Read [references/template-contract.md](references/template-contract.md) before changing the generated file set or merge behavior.
- Read [references/yougile.md](references/yougile.md) when the user asks to connect, install, or monitor TaskPlanner tasks in YouGile. This is an optional second phase after the TaskPlanner board is present; preview before applying and never reuse another user's key or IDs.
- Use the files under `assets/project-template/` as output templates, not as additional instructions.
