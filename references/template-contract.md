# Template contract

## Generated file set

The bootstrap can create:

- `.tasks/config.json` and the five default state files;
- `.tasks/WORK_LOG.md` as a completion ledger, not a task state;
- managed workflow blocks in `AGENTS.md`, `CLAUDE.md`, and `.cursorrules`;
- lightweight documents under `docs/` for current work, product rules, architecture, integrations, decisions, deployment, and quality;
- `.github/pull_request_template.md`.

## Preservation rules

- An existing `.tasks/config.json` owns the board. Do not replace it or its task files.
- Existing project documents are never overwritten by the bootstrap.
- Existing agent-profile content outside managed markers is preserved byte-for-byte except for a final newline needed before appending a block.
- `--refresh-managed` may replace only content inside `PROJECT-SYSTEM` and `TASKPLANNER` marker pairs.
- Placeholders are resolved only while creating new files.

## Generic defaults

The generated rules intentionally avoid language-, framework-, cloud-, database-, and vendor-specific commands. A project should add its confirmed commands and invariants after initialization. Secrets never belong in the board, profiles, documentation templates, logs, examples, or Git history.
