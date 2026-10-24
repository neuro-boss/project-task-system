# Installation and publication

## Install from GitHub

Recommended Codex setup:

1. Install the TaskPlanner plugin from the Codex plugin catalog. It supplies native board commands and keeps its managed profile block synchronized.
2. Install `https://github.com/neuro-boss/project-task-system` with the built-in `skill-installer`, or copy this repository into the personal Codex skills directory as `project-task-system`.
3. Restart or reload Codex if the new skill is not discovered immediately.
4. Open the target repository and invoke `$project-task-system`.

TaskPlanner is the only recommended workflow plugin. GitHub access is optional and needed only for remote publication. The generated board remains plain Markdown and JSON, so it can still be edited and reviewed without a plugin.

The bootstrap default is TaskPlanner `2.1.4`. If a newer plugin is installed, pass its exact semantic version with `--taskplanner-version`; an existing board is always preserved and is never downgraded.

## Publish this skill

Keep `SKILL.md`, `agents/`, `scripts/`, `references/`, and `assets/` together at the repository root. Before publication:

1. Run the skill validator.
2. Run the bootstrap tests.
3. Perform a dry run and an applied run in a temporary empty Git repository.
4. Confirm that a second applied run is idempotent.
5. Check that no secrets, private URLs, personal data, or product-specific instructions are present.

The repository README is for people; `SKILL.md` is the instruction entrypoint used by Codex.

The optional YouGile connector is documented separately in [yougile.md](yougile.md). Its installer and assets must be included when publishing this skill. It is not part of the default TaskPlanner bootstrap.
The reusable Russian prompt is [yougile-prompt.ru.txt](yougile-prompt.ru.txt).


## Shared YouGile hub

For opt-in multi-project onboarding, include `assets/project-task-hub/`,
`scripts/bootstrap_hub.py`, `scripts/project_hub_hook.py` and the hub reference.
See [yougile-hub.md](yougile-hub.md). The runtime installs outside the skill directory;
upgrading/reinstalling the skill preserves the user's local pointer and runtime state.
Upgrade a runtime with the same installer and arguments after stopping its scheduled
job; customized runtime files are preserved for review. Re-enable the existing
Windows schedule with --schedule after checking the preview. Never publish a
user's pointer, .local directory, company configuration, maps, keys or private logs.

Hub 0.6.1 adds saved-project discovery without `.tasks` and dynamic Codex executable
resolution after desktop upgrades. Ship PASSPORT-WORKER.md and the
passport-sync/passport-mcp/passport-wake/codex-mcp/codex-binary/saved-projects
modules with the runtime. The installer also copies `assets/project-template/`
into the persistent runtime, excluding `.github`, so hourly initialization does
not depend on the installed skill directory. First discovery records older saved
paths without connecting them in bulk; future projects remain bounded by approved
roots and manual exclusions. Explain the API/MCP split using
[how-it-works.ru.md](how-it-works.ru.md). Do not enable a model heartbeat as part
of installation: a separately authorized hourly script dispatches an existing
chat only when the passport queue is nonempty. MCP OAuth, company URL, chat ID,
executable policy and publication policy are configured locally by each installation.
Use `binary: "auto"` for saved-project metadata, MCP and wake transports. On Windows
the resolver checks the current desktop installation as well as the environment
and PATH; unavailable Codex leaves pending work for a later hourly attempt.
