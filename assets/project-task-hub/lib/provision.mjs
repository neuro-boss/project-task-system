import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Api } from './api.mjs';
import { json, atomicJson, exists, withLock, fail, digest, iso } from './storage.mjs';
import { canonical, scan, findProject, updateRegistry } from './registry.mjs';
import { connectionHash, loadSnapshot, validateConnection, verifyRemote } from './sync.mjs';

export const columnDefaults = [
  ['Backlog', 'Бэклог', 1], ['Next', 'Следующие', 3], ['In Progress', 'В работе', 4], ['Done', 'Готово', 6], ['Rejected', 'Отклонено', 7],
];
export function newProjectConfig(profile, profilePath, manifest) {
  return { baseUrl: profile.baseUrl, apiKeyFile: resolve(profilePath, profile.apiKeyFile || '.tasks/yougile.api-key.txt'),
    workspaceKey: manifest.workspaceKey, projectId: manifest.projectId, boardId: manifest.boardId, columns: { ...manifest.columns },
    ...(profile.companyName ? { companyName: profile.companyName } : {}),
    activeStates: ['Backlog', 'Next', 'In Progress'], defaultEstimate: profile.defaultEstimate || 'M',
    estimateHours: { XS: 2, S: 3, M: 6, L: 18, XL: 30, ...profile.estimateHours },
    workday: { startHour: 10, hours: 6, timezoneOffsetMinutes: 0, ...structuredClone(profile.workday || {}) },
    historyTimeZone: profile.historyTimeZone || 'UTC',
    priorityColors: { P0: 'task-red', P1: 'task-pink', P2: 'task-yellow', P3: 'task-blue', P4: 'task-gray', ...profile.priorityColors },
    modules: [], moduleStickerName: null, minRequestIntervalMs: profile.minRequestIntervalMs || 1800, timeoutMs: profile.timeoutMs || 20000 };
}
export async function adopt(home, selector, settings, { apply = false } = {}) {
  const project = await findProject(home, selector);
  const snapshot = await loadSnapshot(project.path);
  validateConnection(snapshot.config);
  const registry = await json(join(home, 'registry.json'));
  if (registry.projects.some(p => p.id !== project.id && p.enabled && (p.workspaceKey === snapshot.config.workspaceKey || p.boardId === snapshot.config.boardId)))
    fail('DUPLICATE_CONNECTION', 'Another enabled repository already owns this workspaceKey or board.');
  if (!apply) return { project: project.name, action: 'adopt-existing', tasks: snapshot.tasks.length, mapped: Object.keys(snapshot.mapping).length, remoteWrites: 0 };
  const api = await Api.fromConfig(home, project.path, snapshot.config, settings);
  await verifyRemote(api, snapshot.config);
  await updateRegistry(home, registry => {
    if (registry.projects.some(p => p.id !== project.id && p.enabled && (p.workspaceKey === snapshot.config.workspaceKey || p.boardId === snapshot.config.boardId)))
      fail('DUPLICATE_CONNECTION', 'Another enabled repository already owns this workspaceKey or board.');
    const entry = registry.projects.find(p => p.id === project.id);
    entry.enabled = true; delete entry.manuallyDisabled; entry.adoptedAt ||= iso(); entry.boardId = snapshot.config.boardId;
    entry.connection = connectionHash(snapshot.config); entry.workspaceKey = snapshot.config.workspaceKey;
    entry.historicalClosedIds ||= snapshot.tasks.filter(t => ['Done', 'Rejected'].includes(t.state)).map(t => t.id);
    entry.initialNextId ||= snapshot.board.nextId || Math.max(0, ...snapshot.tasks.map(t => Number(t.id.split('-').at(-1)))) + 1;
    entry.minRequestIntervalMs = settings.minRequestIntervalMs || 1800;
    entry.rateGroup = settings.rateGroup || new URL(snapshot.config.baseUrl).origin;
  });
  return { project: project.name, action: 'adopted', mapped: Object.keys(snapshot.mapping).length, remoteWrites: 0 };
}

export async function provision(home, target, profileRoot, assetRoot, { apply = false, api: suppliedApi } = {}) {
  const root = await canonical(target); const profilePath = await canonical(profileRoot);
  if (await exists(join(root, '.tasks/yougile.local.json'))) return { action: 'preserve-existing-config', project: root };
  const board = await json(join(root, '.tasks/config.json'));
  if (columnDefaults.some(([state]) => !board.states.some(s => s.name === state))) fail('BOARD_STATES', 'Five standard local task states are required.');
  const profile = await json(join(profilePath, '.tasks/yougile.local.json'));
  validateConnection(profile);
  const files = ['taskplanner-yougile-core.mjs', 'taskplanner-yougile-history.mjs', 'taskplanner-yougile-modules-core.mjs', 'taskplanner-yougile-sync.mjs'];
  for (const file of files) {
    const destination = join(root, 'tools', file);
    if (await exists(destination) && !Buffer.from(await readFile(destination)).equals(await readFile(join(assetRoot, file))))
      fail('CUSTOM_CONNECTOR', 'A customized existing connector must be reviewed instead of overwritten.');
  }
  const title = root.split(/[\\/]/).at(-1);
  if (!apply) return { action: 'connect-new-project', title, localTasksPreserved: true, sourceProfile: profilePath, remoteObjects: 'project + board + 5 columns (reuse exact matches)', importHistory: false };
  return withLock(join(home, `provision-${digest(root).slice(0, 20)}.lock`), async () => {
    const manifestPath = join(home, `provision-${digest(root).slice(0, 20)}.json`);
    const manifest = await json(manifestPath, { workspaceKey: `project-${randomUUID()}`, title, columns: {}, startedAt: iso() });
    await atomicJson(manifestPath, manifest);
    const api = suppliedApi || await Api.fromConfig(home, profilePath, profile);
    // Confirm that this key still reaches the approved company profile before creating anything.
    await verifyRemote(api, profile);
    const projects = (await api.list('/projects', { title })).filter(p => p.title === title);
    if (projects.length > 1) fail('AMBIGUOUS_PROJECT', 'Several YouGile projects have this title; select the destination explicitly.');
    if (!manifest.projectId) {
      manifest.projectId = projects[0]?.id || (await api.request('POST', '/projects', { title, idempotencyKey: `${manifest.workspaceKey}:project` })).id;
      await atomicJson(manifestPath, manifest);
    }
    const boards = (await api.list('/boards', { projectId: manifest.projectId })).filter(b => b.title === 'Разработка');
    if (boards.length > 1) fail('AMBIGUOUS_BOARD', 'Several matching YouGile boards exist; select explicitly.');
    if (!manifest.boardId) {
      manifest.boardId = boards[0]?.id || (await api.request('POST', '/boards', { title: 'Разработка', projectId: manifest.projectId, idempotencyKey: `${manifest.workspaceKey}:board` })).id;
      await atomicJson(manifestPath, manifest);
    }
    const columns = await api.list('/columns', { boardId: manifest.boardId });
    for (const [state, name, color] of [...columnDefaults].reverse()) {
      const matches = columns.filter(c => c.title === name);
      if (matches.length > 1) fail('AMBIGUOUS_COLUMN', 'Several matching columns exist; select explicitly.');
      if (!manifest.columns[state]) {
        manifest.columns[state] = matches[0]?.id || (await api.request('POST', '/columns', { title: name, color, boardId: manifest.boardId, idempotencyKey: `${manifest.workspaceKey}:column:${state}` })).id;
        await atomicJson(manifestPath, manifest);
      }
    }
    const config = newProjectConfig(profile, profilePath, manifest);
    await verifyRemote(api, config);
    await mkdir(join(root, 'tools'), { recursive: true });
    for (const file of files) if (!await exists(join(root, 'tools', file))) await copyFile(join(assetRoot, file), join(root, 'tools', file));
    const ignorePath = join(root, '.gitignore');
    const oldIgnore = await readFile(ignorePath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    const ignore = ['.tasks/yougile.local.json', '.tasks/yougile.local-state.json', '.tasks/yougile.local-hashes.json', '.tasks/yougile.api-key.txt', '.tasks/yougile.hub.local.json', '.tasks/yougile.*.tmp'];
    const missing = ignore.filter(s => !oldIgnore.split(/\r?\n/).includes(s));
    if (missing.length) await writeFile(ignorePath, oldIgnore + (oldIgnore.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n', 'utf8');
    // All remote stages are journaled. A retry preserves stable idempotency keys and object IDs.
    if (!await exists(join(root, '.tasks/yougile.local.json'))) await atomicJson(join(root, '.tasks/yougile.local.json'), config);
    manifest.completedAt = iso(); await atomicJson(manifestPath, manifest);
    await scan(home, [root]);
    return { action: 'connected', project: title, importedHistoricalTasks: 0 };
  });
}
