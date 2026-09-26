<!-- YOUGILE-SYNC:START -->

## Optional TaskPlanner → YouGile sync

- `.tasks/*.md` is the source of truth. YouGile is a one-way visualization; do not import client-created cards into TaskPlanner without a separate reviewed workflow.
- New tasks record `Created` and an `Estimate` (XS/S/M/L/XL). Set `Started` and `Completed` once at their actual transitions. `Due` is only a real external deadline; the computed Gantt forecast is not a promise.
- If `.tasks/yougile.local.json` exists and a key is available, after changing a task run `node tools/taskplanner-yougile-sync.mjs --apply --task <ID>`. A sync error must not undo the local task edit. Do not create a duplicate card manually after an error; retry with the same mapping and idempotency key.
- Use `node tools/taskplanner-yougile-sync.mjs` for an offline preview. History import with `--import-history` is separate and requires confirmed Git/Work Log evidence. Never print the key, Authorization header, or local mapping.
- Never commit `.tasks/yougile.local.json`, `.tasks/yougile.local-state.json`, `.tasks/yougile.local-hashes.json`, or a key file. A shared key may be referenced by absolute `apiKeyFile` on this computer; changing/revoking it affects all projects that use it.

<!-- YOUGILE-SYNC:END -->
