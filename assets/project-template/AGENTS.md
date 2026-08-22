# %PROJECT_NAME% — agent instructions

<!-- PROJECT-SYSTEM:START -->

## Start of work

1. Read `docs/current-task.md` before making changes.
2. Read only the relevant parts of `docs/product.md`, `docs/architecture.md`, `docs/integrations.md`, `docs/decisions.md`, and `docs/deployment.md`.
3. Inspect the working tree and preserve unrelated user changes.

## Sources of truth

When sources disagree, use this order:

1. working code and passing tests;
2. approved specifications and acceptance criteria;
3. recorded decisions in `docs/decisions.md`;
4. other documentation and visual references.

Do not silently reinterpret a product rule. Record a new decision when the intended behavior changes.

## Safety and scope

- Never copy secrets, tokens, private URLs, personal data, or production credentials into code, task files, documentation, logs, examples, or Git.
- Treat any discovered secret as compromised; do not print it and record the need for rotation without including its value.
- Do not perform destructive data operations, production migrations, external publication, deployment, commit, or push unless the user explicitly authorizes that scope.
- Keep domain invariants and ownership boundaries in `docs/architecture.md`; do not bypass them for convenience.

## Changes and verification

- Make the smallest coherent change that satisfies the task and preserve unrelated work.
- Do not invent run commands or verification results. Record only commands that were actually executed and their factual outcomes.
- Update the relevant project document and `docs/current-task.md` after a significant change.
- Run checks proportional to risk before completing a task. If a check cannot run, report the exact blocker and what remains unverified.
- A task is done only when implementation, verification, documentation, and TaskPlanner bookkeeping are complete.

<!-- PROJECT-SYSTEM:END -->

<!-- TASKPLANNER:START -->

# TaskPlanner — agent workflow

This repository stores its task board as Markdown files in `.tasks/`. Use the state mapping from `.tasks/config.json`; the default files are:

- Backlog → `BACKLOG.md`
- Next → `NEXT.md`
- In Progress → `IN_PROGRESS.md`
- Done → `DONE.md`
- Rejected → `REJECTED.md`
- Work Log → `WORK_LOG.md` (completion history, not a state)

Each task is one complete `## TASK-001: Title` section through its trailing `---` separator. Never change a task ID or modify unrelated task sections.

## Implementing a task

1. Select the requested task, otherwise the highest-priority item in Next and then Backlog.
2. Move the complete section to `IN_PROGRESS.md` before substantive implementation.
3. When `aiPlanRequired` is enabled, add a concise `### Plan` before writing code.
4. Implement and verify the work.
5. Condense the plan to a short done-summary and move the complete section to `DONE.md`.
6. Add a short entry at the top of `WORK_LOG.md` when it exists.
7. Update `CHANGELOG.md` under `Unreleased` only when the repository uses that convention.

## Creating a task

Read `idPrefix` and `nextId` from `.tasks/config.json`, allocate the padded ID, increment `nextId`, and insert the new complete task at the configured position. Priority is required; default to P2 when the user does not specify one.

Prefer TaskPlanner tools when available. If they cannot access the repository, edit the files directly while preserving their format and all unrelated content.

<!-- TASKPLANNER:END -->
