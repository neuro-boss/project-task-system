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

The optional `bootstrap_yougile.py` is a separate, explicitly requested phase. It may add only its connector scripts, a safe example config, Git ignore entries, and a `YOUGILE-SYNC` block in existing agent profiles. It must not overwrite a differing existing connector, local config, mapping, key, or unrelated profile content.


## Opt-in shared hub

Normal bootstrap may invoke `project_hub_hook.py` after a successful apply. Preview
and --check never invoke the hub. The pointer is local and disabled unless installed
by the user; its policy records the approved roots and company profile. New projects
inside that scope can create remote objects only under the prior explicit opt-in.

The shared installer copies a credential-free runtime to the selected persistent
folder and creates local settings, registry and pointer. Offline scan establishes a
baseline: previously unconfigured projects are excluded once; future discoveries
are eligible. Manual disable persists. Existing project configs, state files and
mapping records are preserved. The bridge modifies only its managed blocks and
appends necessary ignore entries, with backups. Remote operations are journaled and
idempotent; retries never delete cards or import historical Done tasks in bulk.
Customized runtime files stop an upgrade before writes; a pointer to a different
hub is preserved unless the user explicitly opts to replace it.

The persistent runtime includes project templates for opted-in saved-project
discovery. Its metadata-only `project/list` baseline skips older unconfigured
paths; future saved projects inside approved roots receive only missing board,
document and profile files. Existing profiles get missing blocks appended with a
backup, never refreshed implicitly. A pre-existing partial `.tasks` without config
is preserved for review. Explicit `onboard --apply` can initialize a missing board.
No GitHub template is added by this lightweight hourly initializer. Discovery and
MCP/wake resolve the current executable dynamically instead of pinning build hashes.

## Passport lifecycle

With passports.enabled, connected enabled projects receive a create-only
docs/project-passport.md draft and a local revision queue. Existing passports
are never overwritten by the runtime. Important-document hashes trigger semantic
agent review; no task/status churn is published into the passport. Publication is
separately authorized with passports.publisherEnabled and an MCP publisher with conditional OS-script wakeup;
local export never implies remote publication. Preserve existing page bindings,
manual additions and source revision checks. No personal passport/state is bundled.

Conditional wake is opt-in through passports.wake and targets an existing chat.
An empty queue never invokes the CLI/model. Preserve queued request receipts,
start/finish acknowledgement and retry limits; pause any unconditional heartbeat.
