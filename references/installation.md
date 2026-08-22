# Installation and publication

## Install from GitHub

Recommended Codex setup:

1. Install the TaskPlanner plugin from the Codex plugin catalog. It supplies native board commands and keeps its managed profile block synchronized.
2. Install this skill from its GitHub repository with the built-in `skill-installer`, or copy this repository into the personal Codex skills directory as `project-task-system`.
3. Restart or reload Codex if the new skill is not discovered immediately.
4. Open the target repository and invoke `$project-task-system`.

TaskPlanner is the only recommended workflow plugin. GitHub access is optional and needed only for remote publication. The generated board remains plain Markdown and JSON, so it can still be edited and reviewed without a plugin.

## Publish this skill

Keep `SKILL.md`, `agents/`, `scripts/`, `references/`, and `assets/` together at the repository root. Before publication:

1. Run the skill validator.
2. Run the bootstrap tests.
3. Perform a dry run and an applied run in a temporary empty Git repository.
4. Confirm that a second applied run is idempotent.
5. Check that no secrets, private URLs, personal data, or product-specific instructions are present.

The repository README is for people; `SKILL.md` is the instruction entrypoint used by Codex.
