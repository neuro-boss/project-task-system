import { readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json, atomicJson, digest, withLock, sleep, iso, fail, safeError } from './storage.mjs';
import { Api } from './api.mjs';
import { decodeMapping, saveMappingEntry } from './project-state.mjs';
import { renderMarkdown } from './markdown.mjs';
import { collectActivity } from './activity.mjs';

function inside(root, filename) {
  const path = resolve(root, filename); const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('BOARD_PATH', 'Task files must stay inside .tasks.');
  return path;
}
export async function loadSnapshot(root, { settleMs = 800 } = {}) {
  async function capture() {
    const board = await json(join(root, '.tasks/config.json'));
    if (!Array.isArray(board.states) || !board.states.length) fail('BOARD_FORMAT', 'TaskPlanner states are missing.');
    const files = {};
    for (const state of board.states) {
      if (files[state.fileName] !== undefined) fail('BOARD_FORMAT', 'Two task states share a file.');
      files[state.fileName] = await readFile(inside(join(root, '.tasks'), state.fileName), 'utf8');
    }
    const config = await json(join(root, '.tasks/yougile.local.json'));
    const mappingState = await json(join(root, '.tasks/yougile.local-state.json'), {});
    const decoded = decodeMapping(mappingState);
    return { board, files, config, mapping: decoded.mapping, mappingState, mappingFormat: decoded.format,
      fingerprint: digest({ board, files, config, mappingState }) };
  }
  const first = await capture(); await sleep(settleMs); const second = await capture();
  if (first.fingerprint !== second.fingerprint) fail('BOARD_CHANGING', 'Task files are changing; retry on the next cycle.');
  const corePath = join(root, 'tools/taskplanner-yougile-core.mjs');
  const core = await import(`${pathToFileURL(corePath)}?mtime=${(await stat(corePath)).mtimeMs}`);
  const tasks = [];
  const prefix = second.board.idPrefix || 'TASK';
  const heading = new RegExp(`^## ${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+:`, 'gm');
  for (const state of second.board.states) {
    const markdown = second.files[state.fileName];
    const parsed = core.parseTaskFile(markdown, state.name, prefix);
    if (parsed.length !== [...markdown.matchAll(heading)].length) fail('TASK_FORMAT', 'Incomplete task section detected; no remote changes were made.');
    tasks.push(...parsed);
  }
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) fail('DUPLICATE_TASK', 'Duplicate task IDs detected; retry after the task move finishes.');
  let effectiveTasks = tasks;
  if (second.mappingFormat === 'mapping' && second.mappingState.history) {
    const historyPath = join(root, 'tools/taskplanner-yougile-history.mjs');
    const history = await import(`${pathToFileURL(historyPath)}?mtime=${(await stat(historyPath)).mtimeMs}`);
    effectiveTasks = history.enrichTasksWithHistoricalDates(tasks, new Map(Object.entries(second.mappingState.history)));
  }
  return { ...second, core, tasks: effectiveTasks };
}
export function validateConnection(config, project) {
  const states = ['Backlog', 'Next', 'In Progress', 'Done', 'Rejected'];
  if (!config.workspaceKey || config.workspaceKey.startsWith('replace-') || !config.boardId || !config.projectId) fail('CONNECTION', 'YouGile connection is incomplete.');
  if (states.some(s => !config.columns?.[s]) || new Set(states.map(s => config.columns[s])).size !== states.length) fail('CONNECTION', 'Five distinct YouGile columns are required.');
  if (project?.connection && connectionHash(config) !== project.connection)
    fail('CONNECTION_CHANGED', 'Project destination changed; re-adopt explicitly before writing to another board.');
}
export function connectionHash(config) {
  return digest({ baseUrl: config.baseUrl, workspaceKey: config.workspaceKey, boardId: config.boardId, projectId: config.projectId, columns: config.columns });
}
export function dayAnchor(config, now = Date.now()) {
  const offset = (config.workday?.timezoneOffsetMinutes || 0) * 60_000;
  return new Date(Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset);
}
export function selectTasks(snapshot, baseline, taskId, initialNextId) {
  if (taskId) {
    const task = snapshot.tasks.find(t => t.id === taskId);
    if (!task) fail('TASK_NOT_FOUND', 'The requested task is not present in the stable local board.');
    return [task];
  }
  const active = new Set(snapshot.config.activeStates || ['Backlog', 'Next', 'In Progress']);
  const historicalClosed = new Set(baseline || []);
  const syncBoundary = snapshot.config.syncFromTaskId ? Number(snapshot.config.syncFromTaskId.split('-').at(-1)) : null;
  if (syncBoundary !== null && !Number.isInteger(syncBoundary)) fail('SYNC_BOUNDARY', 'Invalid configured syncFromTaskId.');
  return snapshot.tasks.filter(t => active.has(t.state) || snapshot.mapping[t.id] || (!historicalClosed.has(t.id) &&
    (!Number.isInteger(initialNextId) || Number(t.id.split('-').at(-1)) >= initialNextId)) ||
    (syncBoundary !== null && Number(t.id.split('-').at(-1)) >= syncBoundary));
}
export function ownedPayload(payload, creating) {
  const result = structuredClone(payload);
  if (!creating) { delete result.idempotencyKey; delete result.archived; }
  if (result.deadline) { delete result.deadline.blockedPoints; delete result.deadline.links; }
  return result;
}
export function transportPayload(payload) {
  return { ...payload, ...(typeof payload.description === 'string' ? {
    description: renderMarkdown(payload.description),
  } : {}) };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export const payloadHash = payload => digest(JSON.stringify(stable(payload)) ?? 'undefined');
export function matchesOwned(remote, payload) {
  const text = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n').replace(/<br\s*\/?>/gi, '<br>').replace(/<hr\s*\/?>/gi, '<hr>').replace(/<\/?(?:code|blockquote)>/gi, '') : value;
  const decodedText = value => typeof value === 'string' ? value.replace(/&(amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, (entity, code) => {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    if (names[code.toLowerCase()]) return names[code.toLowerCase()];
    const point = code.toLowerCase().startsWith('#x') ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  }) : value;
  return Object.entries(payload).every(([key, value]) => {
    if (key === 'idempotencyKey') return true;
    if (key === 'description') return text(remote[key]) === text(value) || text(decodedText(remote[key])) === text(value);
    if (key === 'deadline' && (value === null || value?.deleted)) return !remote.deadline || remote.deadline.deleted === true || (!remote.deadline.startDate && !remote.deadline.deadline);
    if (key === 'stickers' || key === 'deadline') return !!remote[key] && Object.entries(value).every(([k, v]) => payloadHash(remote[key][k]) === payloadHash(v));
    return payloadHash(remote[key] ?? (typeof value === 'boolean' ? false : null)) === payloadHash(value);
  });
}
export async function verifyRemote(api, config) {
  if (config.companyName) {
    const company = await api.request('GET', '/companies');
    if (company.title !== config.companyName && company.name !== config.companyName) fail('REMOTE_COMPANY', 'The existing key does not match the configured company.');
  }
  const board = await api.request('GET', `/boards/${config.boardId}`);
  if (board.deleted || board.projectId !== config.projectId) fail('REMOTE_BOARD', 'The configured board does not belong to the expected project.');
  const columns = await api.list('/columns', { boardId: config.boardId });
  if (Object.values(config.columns).some(id => !columns.some(c => c.id === id && c.boardId === config.boardId))) fail('REMOTE_COLUMNS', 'A configured column is missing or belongs to another board.');
  const taskStickers = {};
  for (const name of new Set([config.moduleStickerName, config.leadMagnetStickerName].filter(Boolean))) {
    const stickers = (await api.list('/string-stickers', { boardId: config.boardId, name })).filter(s => s.name === name);
    if (stickers.length !== 1) fail('MODULE_STICKER', 'A configured project sticker is missing or ambiguous.');
    taskStickers[name] = stickers[0];
    if (name === config.moduleStickerName && config.moduleStickerId && stickers[0].id !== config.moduleStickerId)
      fail('MODULE_STICKER', 'The existing module sticker ID changed.');
    if ((config.moduleStickerId || config.leadMagnetStickerName) && board.stickers?.custom?.[stickers[0].id] !== true)
      fail('MODULE_STICKER', 'A configured project sticker is not enabled on this board.');
  }
  return { board, columns, sticker: taskStickers[config.moduleStickerName] || null, taskStickers };
}
async function remoteCards(api, config) {
  const cards = new Map();
  for (const columnId of Object.values(config.columns)) {
    for (const task of await api.list('/tasks', { columnId })) cards.set(task.id, task);
  }
  return cards;
}
export async function buildOperations(snapshot, project, taskId) {
  const { config, core, tasks, mapping } = snapshot;
  let anchor = dayAnchor(config); let forecastState;
  if (snapshot.mappingFormat === 'mapping' && snapshot.mappingState.forecasts) {
    const signature = digest({ calendar: config.workday, estimates: config.estimateHours,
      tasks: tasks.filter(t => ['Next', 'In Progress'].includes(t.state)).map(t => [t.id, t.state, t.metadata.Started, t.metadata.Estimate, t.metadata['Forecast Start'], t.metadata['Forecast Finish']]) });
    const previous = snapshot.mappingState.forecasts;
    anchor = previous.signature === signature && previous.anchor ? new Date(previous.anchor) : new Date();
    if (!Number.isFinite(anchor.getTime())) fail('FORECAST_STATE', 'The existing forecast anchor is invalid.');
    forecastState = { ...previous, signature, anchor: anchor.toISOString() };
  }
  const { forecasts, warnings = [] } = core.buildForecast(tasks, anchor, config);
  let modules;
  if (config.moduleStickerName) {
    const path = join(project.path, 'tools/taskplanner-yougile-modules-core.mjs');
    modules = await import(`${pathToFileURL(path)}?mtime=${(await stat(path)).mtimeMs}`);
  }
  const operations = selectTasks(snapshot, project.historicalClosedIds, taskId, project.initialNextId).map(task => {
    const creating = !mapping[task.id];
    const classification = modules?.classifyTaskModule(task, config);
    const leadMagnet = config.leadMagnetStickerName ? modules?.classifyLeadMagnet(task)?.definition : null;
    if (config.leadMagnetStickerName && !leadMagnet) fail('LEAD_MAGNET', 'The existing lead-magnet classifier did not return a valid assignment.');
    const sourcePayload = ownedPayload(core.buildYouGilePayload(task, forecasts.get(task.id), config, creating), creating);
    const payload = transportPayload(sourcePayload);
    const stablePayload = { ...sourcePayload }; delete stablePayload.idempotencyKey;
    return { taskId: task.id, state: task.state, remoteId: mapping[task.id] || null,
      module: classification?.module?.name || null, leadMagnet: leadMagnet?.name || null,
      ...(snapshot.mappingFormat === 'tasks' && core.fingerprint ? { nativeFingerprint: core.fingerprint({ payload: stablePayload, module: classification?.module?.key, leadMagnet: leadMagnet?.key }) } : {}), payload };
  });
  return { operations, warnings, forecastState };
}
export async function syncProject(home, project, { apply = false, taskId, api: providedApi, maxWrites = 40, reconcile = false } = {}) {
  return withLock(join(home, `project-${project.id}.lock`), async () => {
    if (!project.enabled && apply) fail('PROJECT_DISABLED', 'Enable this project explicitly before synchronizing.');
    const snapshot = await loadSnapshot(project.path);
    validateConnection(snapshot.config, project);
    const { operations, warnings, forecastState } = await buildOperations(snapshot, project, taskId);
    const cachePath = join(home, `cache-${project.id}.json`);
    const cache = await json(cachePath, { schemaVersion: 1, tasks: {} });
    const result = { project: project.name, selected: operations.length, created: 0, updated: 0, adopted: 0, unchanged: 0, pending: 0, warnings: warnings.length };
    if (!apply) {
      for (const operation of operations) {
        const hash = payloadHash({ payload: ownedPayload(operation.payload, false), module: operation.module, leadMagnet: operation.leadMagnet });
        if (cache.tasks[operation.taskId]?.sourceHash === hash && cache.tasks[operation.taskId]?.remoteId === operation.remoteId) result.unchanged++;
        else result.pending++;
      }
      return { ...result, mode: 'dry-run', networkRequests: 0 };
    }
    const api = providedApi || await Api.fromConfig(home, project.path, snapshot.config, project);
    const planFingerprint = payloadHash(operations.map(o => ({ taskId: o.taskId, module: o.module, leadMagnet: o.leadMagnet, payload: ownedPayload(o.payload, false) })));
    const desiredFingerprint = digest({ snapshot: snapshot.fingerprint, day: dayAnchor(snapshot.config).toISOString(), plan: planFingerprint });
    if (!taskId && !reconcile && cache.fingerprint === desiredFingerprint && !cache.pending && cache.verifiedAt && Date.now() - Date.parse(cache.verifiedAt) < 6 * 3600_000)
      return { ...result, unchanged: operations.length, mode: 'unchanged', networkRequests: 0 };
    const verified = await verifyRemote(api, snapshot.config);
    // First adoption and periodic reconciliation compare real remote values instead of rewriting history.
    const mustReconcile = reconcile || !cache.verifiedAt || Date.now() - Date.parse(cache.verifiedAt) >= 6 * 3600_000;
    const uncachedCount = operations.filter(o => !o.remoteId || cache.tasks[o.taskId]?.sourceHash !==
      payloadHash({ payload: ownedPayload(o.payload, false), module: o.module, leadMagnet: o.leadMagnet })).length;
    const cards = mustReconcile || operations.some(o => !o.remoteId) || uncachedCount > 8 ? await remoteCards(api, snapshot.config) : new Map();
    const byLocalId = new Map();
    for (const remote of cards.values()) {
      const localId = /^(?:\[([A-Z][A-Z0-9]*-\d+)\]|([A-Z][A-Z0-9]*-\d+):)/.exec(remote.title || '');
      const id = localId?.[1] || localId?.[2];
      if (!id) continue;
      if (byLocalId.has(id)) fail('DUPLICATE_REMOTE_TASK', 'Several remote cards have the same local task ID; no duplicates were created.');
      byLocalId.set(id, remote);
    }
    if (forecastState && maxWrites > 0) {
      const statePath = join(project.path, '.tasks/yougile.local-state.json');
      const existingState = await json(statePath);
      if (payloadHash(existingState.forecasts) !== payloadHash(forecastState)) await atomicJson(statePath, { ...existingState, forecasts: forecastState });
    }
    let writes = 0;
    for (const operation of operations) {
      const mappedRemoteId = operation.remoteId;
      let payload = { ...operation.payload };
      for (const [name, value] of [[snapshot.config.moduleStickerName, operation.module], [snapshot.config.leadMagnetStickerName, operation.leadMagnet]]) {
        if (!value) continue;
        const sticker = verified.taskStickers[name];
        const matches = sticker?.states?.filter(s => !s.deleted && s.name === value) || [];
        if (matches.length !== 1) fail('MODULE_STATE', 'A required project sticker state is missing or ambiguous.');
        payload.stickers = { ...payload.stickers, [sticker.id]: matches[0].id };
      }
      const canonicalPayload = ownedPayload(payload, false);
      const hash = payloadHash(canonicalPayload);
      const sourceHash = payloadHash({ payload: ownedPayload(operation.payload, false), module: operation.module, leadMagnet: operation.leadMagnet });
      const cached = cache.tasks[operation.taskId];
      if (!mustReconcile && operation.remoteId && cached?.remoteId === operation.remoteId && cached?.hash === hash) { result.unchanged++; continue; }
      let remote = operation.remoteId ? cards.get(operation.remoteId) : byLocalId.get(operation.taskId);
      if (operation.remoteId && !remote) {
        try { remote = await api.request('GET', `/tasks/${operation.remoteId}`); }
        catch (e) { if (e.code === 'HTTP_404') fail('REMOTE_CARD_MISSING', 'A mapped card is missing. Mapping was preserved; no replacement card was created.'); throw e; }
      }
      if (remote && (remote.deleted || !Object.values(snapshot.config.columns).includes(remote.columnId))) fail('REMOTE_CARD_MOVED', 'A mapped card was deleted or moved to another board; review it before retrying.');
      const remoteLocalId = /^(?:\[([A-Z][A-Z0-9]*-\d+)\]|([A-Z][A-Z0-9]*-\d+):)/.exec(remote?.title || '');
      if (remoteLocalId && (remoteLocalId[1] || remoteLocalId[2]) !== operation.taskId) fail('MAPPING_CHANGED', 'A mapped card has another local task ID; the original mapping was preserved.');
      if (remote && !operation.remoteId) operation.remoteId = remote.id;
      if (remote && matchesOwned(remote, canonicalPayload)) {
        if (!mappedRemoteId) {
          if (maxWrites === 0) {
            result.pending++; result.changes ||= []; result.changes.push({ taskId: operation.taskId, action: 'recover-existing-mapping', fields: [] }); continue;
          }
          await saveMappingEntry(join(project.path, '.tasks/yougile.local-state.json'), operation.taskId, remote.id, operation.nativeFingerprint);
          snapshot.mapping[operation.taskId] = remote.id; result.recovered = (result.recovered || 0) + 1;
        }
        cache.tasks[operation.taskId] = { hash, sourceHash, remoteId: operation.remoteId };
        result.adopted++; continue;
      }
      // A real remote mismatch invalidates an earlier acknowledged-write hash.
      // Otherwise a read-only audit could report drift that the next sync skips.
      if (cache.tasks[operation.taskId]) {
        delete cache.tasks[operation.taskId]; cache.pending = true;
        await atomicJson(cachePath, cache);
      }
      if (writes >= maxWrites) {
        result.pending++;
        if (maxWrites === 0) {
          result.changes ||= [];
          result.changes.push({ taskId: operation.taskId, action: operation.remoteId ? 'update' : 'create',
            fields: Object.keys(canonicalPayload).filter(key => !remote || !matchesOwned(remote, { [key]: canonicalPayload[key] })) });
        }
        continue;
      }
      // Detect an agent changing the source while network requests are in progress.
      const latest = await loadSnapshot(project.path, { settleMs: 0 });
      if (digest({ files: latest.files, config: latest.config, board: latest.board }) !== digest({ files: snapshot.files, config: snapshot.config, board: snapshot.board }))
        fail('BOARD_CHANGING', 'The board changed during synchronization; completed writes were retained and remaining work will retry.');
      const currentMap = decodeMapping(await json(join(project.path, '.tasks/yougile.local-state.json'), {})).mapping;
      if ((currentMap[operation.taskId] || null) !== mappedRemoteId) fail('MAPPING_CHANGED', 'Another connector changed the mapping; retry with the current mapping.');
      // Preserve client-maintained sticker fields and Gantt dependencies.
      if (remote?.stickers && payload.stickers) payload.stickers = { ...remote.stickers, ...payload.stickers };
      if (remote?.deadline && payload.deadline) payload.deadline = { ...remote.deadline, ...payload.deadline };
      if (operation.remoteId) {
        delete payload.idempotencyKey;
        await api.request('PUT', `/tasks/${operation.remoteId}`, payload); result.updated++;
        if (!mappedRemoteId) {
          await saveMappingEntry(join(project.path, '.tasks/yougile.local-state.json'), operation.taskId, operation.remoteId, operation.nativeFingerprint);
          snapshot.mapping[operation.taskId] = operation.remoteId; result.recovered = (result.recovered || 0) + 1;
        }
      } else {
        if (!payload.idempotencyKey || payload.idempotencyKey !== `${snapshot.config.workspaceKey}:${operation.taskId}`) fail('IDEMPOTENCY', 'Stable task idempotency key is required.');
        const created = await api.request('POST', '/tasks', payload);
        if (!created?.id) fail('CREATE_RESPONSE', 'YouGile did not return the created card ID.');
        await saveMappingEntry(join(project.path, '.tasks/yougile.local-state.json'), operation.taskId, created.id, operation.nativeFingerprint);
        operation.remoteId = created.id; snapshot.mapping[operation.taskId] = created.id; result.created++;
      }
      writes++;
      cache.tasks[operation.taskId] = { hash, sourceHash, remoteId: operation.remoteId };
      cache.pending = true; await atomicJson(cachePath, cache);
    }
    // Fingerprint includes new map IDs so successful creates do not force a second pass.
    const finalSnapshot = await loadSnapshot(project.path, { settleMs: 0 });
    const changedDuringRun = digest({ files: finalSnapshot.files, config: finalSnapshot.config, board: finalSnapshot.board }) !== digest({ files: snapshot.files, config: snapshot.config, board: snapshot.board });
    // A targeted agent call cannot certify that the rest of the board is synchronized.
    if (!taskId) cache.fingerprint = changedDuringRun ? null : digest({ snapshot: finalSnapshot.fingerprint, day: dayAnchor(snapshot.config).toISOString(), plan: planFingerprint });
    cache.pending = result.pending > 0 || changedDuringRun || (taskId && !!cache.pending);
    if (changedDuringRun) result.pending++;
    if (mustReconcile) cache.verifiedAt = iso();
    cache.lastSuccessAt = iso(); cache.result = result;
    await atomicJson(cachePath, cache);
    return { ...result, mode: 'apply' };
  });
}
export async function recordSync(home, project, options) {
  const statusPath = join(home, `status-${project.id}.json`);
  const status = await json(statusPath, {});
  let activityError;
  if (options.apply && options.maxWrites !== 0) {
    try { await collectActivity(home, project, { apply: true }); } catch (error) { activityError = safeError(error); }
  }
  try {
    const result = await syncProject(home, project, options);
    if (activityError) result.activityError = activityError;
    if (options.apply) await atomicJson(statusPath, { ...status, lastAttemptAt: iso(), lastSuccessAt: iso(), failures: 0, nextAttemptAt: null, error: null, result });
    return result;
  } catch (e) {
    if (e.code === 'BUSY') return { project: project.name, mode: 'busy', pending: true };
    if (options.apply) {
      const failures = (status.failures || 0) + 1;
      await atomicJson(statusPath, { ...status, lastAttemptAt: iso(), failures,
        nextAttemptAt: new Date(Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** Math.min(failures - 1, 7))).toISOString(), error: safeError(e) });
    }
    throw e;
  }
}
