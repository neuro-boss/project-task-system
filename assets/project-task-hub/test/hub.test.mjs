import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicJson, json, lock, BusyError, digest, safeError } from '../lib/storage.mjs';
import { discover, scan, findProject } from '../lib/registry.mjs';
import { syncProject, loadSnapshot, connectionHash, dayAnchor, ownedPayload, matchesOwned, transportPayload } from '../lib/sync.mjs';
import { Api } from '../lib/api.mjs';
import { decodeMapping, saveMappingEntry } from '../lib/project-state.mjs';

const source = fileURLToPath(new URL('../vendor/yougile/', import.meta.url));
const states = [['Backlog', 'BACKLOG.md'], ['Next', 'NEXT.md'], ['In Progress', 'IN_PROGRESS.md'], ['Done', 'DONE.md'], ['Rejected', 'REJECTED.md']];
const section = (id, title, extra = '') => `## ${id}: ${title}\n**Priority:** P2\n**Estimate:** S\n**Created:** 2026-10-15 12:00\n${extra}\n\n---\n`;
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'project-task-hub-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'); const home = join(base, 'hub');
  await mkdir(join(root, '.tasks'), { recursive: true }); await mkdir(join(root, 'tools')); await mkdir(home);
  await atomicJson(join(root, '.tasks/config.json'), { idPrefix: 'TASK', states: states.map(([name, fileName]) => ({ name, fileName })) });
  for (const [, filename] of states) await writeFile(join(root, '.tasks', filename), '# Tasks\n');
  await writeFile(join(root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Existing task')}`);
  await writeFile(join(root, '.tasks/DONE.md'), `# Done\n\n${section('TASK-002', 'Historical task')}`);
  const config = { baseUrl: 'https://yougile.com/api-v2', workspaceKey: 'fixture', projectId: 'p1', boardId: 'b1',
    columns: Object.fromEntries(states.map(([name], i) => [name, `c${i}`])), activeStates: ['Backlog', 'Next', 'In Progress'],
    workday: { startHour: 10, hours: 6, timezoneOffsetMinutes: 180 }, apiKeyFile: 'missing-key.txt' };
  await atomicJson(join(root, '.tasks/yougile.local.json'), config);
  await atomicJson(join(root, '.tasks/yougile.local-state.json'), { 'TASK-001': 'remote-1' });
  await copyFile(join(source, 'taskplanner-yougile-core.mjs'), join(root, 'tools/taskplanner-yougile-core.mjs'));
  const project = { id: digest(root).slice(0, 20), name: 'Fixture', path: root, enabled: true, initialNextId: 3, historicalClosedIds: ['TASK-002'], connection: connectionHash(config) };
  const core = await import(pathToFileURL(join(root, 'tools/taskplanner-yougile-core.mjs')));
  const local = core.parseTaskFile(await readFile(join(root, '.tasks/BACKLOG.md'), 'utf8'), 'Backlog')[0];
  const payload = core.buildYouGilePayload(local, undefined, config, false);
  const cards = new Map([['remote-1', { id: 'remote-1', ...payload, assigned: ['a-client-user'], stickers: { 'client-sticker': 'retain' }, archived: true }]]);
  const calls = []; let next = 1;
  const api = {
    async request(method, path, body) {
      calls.push({ method, path, body: structuredClone(body) });
      if (method === 'GET' && path.startsWith('/boards/')) return { id: 'b1', projectId: 'p1' };
      if (method === 'GET' && path.startsWith('/tasks/')) {
        const card = cards.get(path.split('/').at(-1));
        if (!card) { const e = new Error(); e.code = 'HTTP_404'; throw e; } return structuredClone(card);
      }
      if (method === 'PUT') { const id = path.split('/').at(-1); cards.set(id, { ...cards.get(id), ...body }); return { id }; }
      if (method === 'POST') { const id = `new-${next++}`; cards.set(id, { id, ...body }); return { id }; }
      throw new Error(`Unexpected ${method} ${path}`);
    },
    async list(path, filters) {
      calls.push({ method: 'GET', path, filters });
      if (path === '/columns') return Object.values(config.columns).map(id => ({ id, boardId: 'b1' }));
      if (path === '/tasks') return [...cards.values()].filter(c => c.columnId === filters.columnId).map(c => structuredClone(c));
      if (path === '/string-stickers') return [];
      throw new Error(`Unexpected list ${path}`);
    },
  };
  return { base, home, root, project, config, cards, calls, api };
}

test('adopts matching remote cards without writes or changes to task files', async t => {
  const f = await fixture(t); const before = await readFile(join(f.root, '.tasks/BACKLOG.md'));
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.adopted, 1); assert.equal(result.selected, 1);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  assert.deepEqual(await readFile(join(f.root, '.tasks/BACKLOG.md')), before);
  assert.deepEqual(await json(join(f.root, '.tasks/yougile.local-state.json')), { 'TASK-001': 'remote-1' });
});
test('unchanged second cycle makes zero API calls', async t => {
  const f = await fixture(t); await syncProject(f.home, f.project, { apply: true, api: f.api }); f.calls.length = 0;
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.mode, 'unchanged'); assert.equal(f.calls.length, 0);
});
test('updates one modified card; keeps ID, client assignee, stickers and archive', async t => {
  const f = await fixture(t); await syncProject(f.home, f.project, { apply: true, api: f.api });
  await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Modified task')}`);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.updated, 1); assert.equal(result.created, 0);
  const card = f.cards.get('remote-1'); assert.equal(card.title, 'TASK-001: Modified task'); assert.deepEqual(card.assigned, ['a-client-user']);
  assert.deepEqual(card.stickers, { 'client-sticker': 'retain' }); assert.equal(card.archived, true);
});
test('creates a new task exactly once and saves the stable mapping', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Existing task')}${section('TASK-003', 'New task')}`);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.created, 1);
  const post = f.calls.find(c => c.method === 'POST'); assert.equal(post.body.idempotencyKey, 'fixture:TASK-003');
  const map = await json(join(f.root, '.tasks/yougile.local-state.json')); assert.equal(map['TASK-003'], 'new-1');
  await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('newly completed unmapped task is included, historical Done stays excluded', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.tasks/DONE.md'), `# Done\n\n${section('TASK-002', 'Historical task')}${section('TASK-003', 'Just finished')}`);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.created, 1); const map = await json(join(f.root, '.tasks/yougile.local-state.json'));
  assert.equal(map['TASK-002'], undefined); assert.ok(map['TASK-003']);
});
test('offline preview does not read a key or access the API', async t => {
  const f = await fixture(t); const result = await syncProject(f.home, f.project);
  assert.equal(result.networkRequests, 0); assert.equal(f.calls.length, 0);
});
test('duplicate IDs abort before network or mapping writes', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.tasks/NEXT.md'), `# Next\n\n${section('TASK-001', 'Moving')}`);
  await assert.rejects(syncProject(f.home, f.project, { apply: true, api: f.api }), { code: 'DUPLICATE_TASK' }); assert.equal(f.calls.length, 0);
});
test('incomplete task section aborts before API', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.tasks/NEXT.md'), '## TASK-004: Half written\nDescription\n');
  await assert.rejects(syncProject(f.home, f.project, { apply: true, api: f.api }), { code: 'TASK_FORMAT' }); assert.equal(f.calls.length, 0);
});
test('missing mapped remote card never creates a replacement', async t => {
  const f = await fixture(t); f.cards.clear();
  await assert.rejects(syncProject(f.home, f.project, { apply: true, api: f.api }), { code: 'REMOTE_CARD_MISSING' });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('changed board or API destination requires explicit readoption', async t => {
  const f = await fixture(t); await atomicJson(join(f.root, '.tasks/yougile.local.json'), { ...f.config, baseUrl: 'https://changed.example/api-v2' });
  await assert.rejects(syncProject(f.home, f.project, { apply: true, api: f.api }), { code: 'CONNECTION_CHANGED' }); assert.equal(f.calls.length, 0);
});
test('per-project lock rejects simultaneous workers', async t => {
  const f = await fixture(t); const release = await lock(join(f.home, `project-${f.project.id}.lock`));
  await assert.rejects(syncProject(f.home, f.project), BusyError); await release();
});
test('corrupt mapping is not treated as empty', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.tasks/yougile.local-state.json'), '{invalid');
  await assert.rejects(loadSnapshot(f.root)); assert.equal(f.calls.length, 0);
});
test('canonical discovery deduplicates junction aliases and leaves discoveries disabled', async t => {
  const f = await fixture(t); const alias = join(f.base, 'alias'); await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await discover([alias, f.root])).length, 1);
  await scan(f.home, [alias, f.root]); const entry = await findProject(f.home, f.root); assert.equal(entry.enabled, false);
});
test('two worktrees share a registry identity and do not replace selected source', async t => {
  const f = await fixture(t); const common = join(f.root, '.git'); await mkdir(common);
  const worktree = join(f.base, 'worktree'); await mkdir(join(worktree, '.tasks'), { recursive: true });
  await copyFile(join(f.root, '.tasks/config.json'), join(worktree, '.tasks/config.json'));
  const gitdir = join(common, 'worktrees/feature'); await mkdir(gitdir, { recursive: true });
  await writeFile(join(gitdir, 'commondir'), '../..'); await writeFile(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  await scan(f.home, [f.root, worktree]); const registry = await json(join(f.home, 'registry.json'));
  assert.equal(registry.projects.length, 1); assert.equal(registry.projects[0].path, await (await import('node:fs/promises')).realpath(f.root));
});
test('forecast anchor stays constant within Moscow calendar day', () => {
  const cfg = { workday: { timezoneOffsetMinutes: 180 } };
  assert.equal(dayAnchor(cfg, Date.parse('2026-10-15T00:00:00Z')).getTime(), dayAnchor(cfg, Date.parse('2026-10-15T20:59:59Z')).getTime());
  assert.notEqual(dayAnchor(cfg, Date.parse('2026-10-15T21:00:00Z')).getTime(), dayAnchor(cfg, Date.parse('2026-10-15T20:59:59Z')).getTime());
});
test('API retries POST only with stable idempotency key', async t => {
  const f = await fixture(t); let calls = 0;
  const api = new Api({ home: f.home, baseUrl: 'https://yougile.com/api-v2', key: 'test-only-not-a-real-key', intervalMs: 0, fetchFn: async () => { calls++; throw new Error('private remote content'); } });
  api.reserve = async () => {};
  await assert.rejects(api.request('POST', '/tasks', { title: 'x' }), { code: 'NETWORK' }); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(api.request('POST', '/tasks', { idempotencyKey: 'fixture:TASK-001' }, { attempts: 2 }), { code: 'NETWORK' }); assert.equal(calls, 2);
});
test('pagination consumes every page', async t => {
  const f = await fixture(t); let calls = 0;
  const api = new Api({ home: f.home, baseUrl: 'https://yougile.com/api-v2', key: 'test-only', fetchFn: async () => {} });
  api.request = async (method, path) => { calls++; return { content: [{ id: String(calls) }], paging: { next: calls === 1 } }; };
  assert.deepEqual((await api.list('/projects')).map(p => p.id), ['1', '2']); assert.equal(calls, 2);
});
test('write cap retains pending work and later resumes', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Changed')}${section('TASK-003', 'New')}`);
  const first = await syncProject(f.home, f.project, { apply: true, api: f.api, maxWrites: 1 });
  assert.equal(first.pending, 1);
  const second = await syncProject(f.home, f.project, { apply: true, api: f.api, maxWrites: 1 });
  assert.equal(second.pending, 0); assert.equal(second.created, 1);
});
test('unknown exception messages are never copied to status/logs', () => {
  const safe = safeError(new Error('Authorization: Bearer confidential'));
  assert.ok(!JSON.stringify(safe).includes('confidential'));
});
test('targeted agent call does not hide changes to another task', async t => {
  const f = await fixture(t); await syncProject(f.home, f.project, { apply: true, api: f.api });
  await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Changed')}${section('TASK-003', 'New')}`);
  await syncProject(f.home, f.project, { apply: true, api: f.api, taskId: 'TASK-001' });
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.created, 1); assert.equal(result.pending, 0);
});
test('task change after the last API write is retried on the next cycle', async t => {
  const f = await fixture(t); await syncProject(f.home, f.project, { apply: true, api: f.api });
  await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Changed')}`);
  const request = f.api.request.bind(f.api); let changed = false;
  f.api.request = async (...args) => {
    const response = await request(...args);
    if (args[0] === 'PUT' && !changed) {
      changed = true; await writeFile(join(f.root, '.tasks/NEXT.md'), `# Next\n\n${section('TASK-003', 'Arrived while syncing')}`);
    }
    return response;
  };
  const first = await syncProject(f.home, f.project, { apply: true, api: f.api }); assert.equal(first.pending, 1);
  const second = await syncProject(f.home, f.project, { apply: true, api: f.api }); assert.equal(second.created, 1);
});
test('a malformed discovered connection does not prevent discovering other projects', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.tasks/yougile.local.json'), '{bad');
  const found = await discover([f.root]); assert.equal(found.length, 1); assert.equal(found[0].configurationError, true);
});
test('API 429 postpones the shared limiter and retries safely', async t => {
  const f = await fixture(t); let calls = 0;
  const api = new Api({ home: f.home, baseUrl: 'https://yougile.com/api-v2', key: 'test-only', fetchFn: async () => {
    calls++; return calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }) : new Response('{"id":"ok"}', { status: 200 });
  } });
  api.reserve = async () => {};
  assert.equal((await api.request('GET', '/projects')).id, 'ok'); assert.equal(calls, 2);
  const rate = await json(join(f.home, `rate-${api.group}.json`)); assert.ok(rate.nextAt > Date.now());
});
test('separate API clients share the same rate reservation', async t => {
  const f = await fixture(t);
  const opts = { home: f.home, baseUrl: 'https://yougile.com/api-v2', key: 'test-only', intervalMs: 70 };
  const first = new Api(opts); const second = new Api(opts);
  await first.reserve(); const start = Date.now(); await second.reserve(); assert.ok(Date.now() - start >= 40);
});
test('restoring an older unmapped closed task does not import history', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.tasks/DONE.md'), `# Done\n\n${section('TASK-000', 'Restored historical task')}${section('TASK-002', 'Historical task')}`);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.created, 0); assert.equal(result.selected, 1);
});
test('changed project payload rules invalidate the unchanged fingerprint', async t => {
  const f = await fixture(t); await syncProject(f.home, f.project, { apply: true, api: f.api });
  const corePath = join(f.root, 'tools/taskplanner-yougile-core.mjs');
  const code = await readFile(corePath, 'utf8');
  const modified = code.replace('title: `${task.id}: ${task.title}`', 'title: `${task.id}: ${task.title} [v2]`');
  assert.notEqual(modified, code); await writeFile(corePath, modified);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.updated, 1); assert.equal(f.cards.get('remote-1').title, 'TASK-001: Existing task [v2]');
});
test('nested mapping retains forecasts/history when saving a new card', async t => {
  const f = await fixture(t); const statePath = join(f.root, '.tasks/yougile.local-state.json');
  const forecasts = { signature: 'known', anchor: '2026-10-15T07:00:00.000Z' }; const history = { 'TASK-001': { created: { value: '2026-10-14', source: 'confirmed' } } };
  await atomicJson(statePath, { mapping: { 'TASK-001': 'remote-1' }, forecasts, history });
  await saveMappingEntry(statePath, 'TASK-003', 'new-id'); const after = await json(statePath);
  assert.deepEqual(after.forecasts, forecasts); assert.deepEqual(after.history, history);
  assert.deepEqual(after.mapping, { 'TASK-001': 'remote-1', 'TASK-003': 'new-id' });
});
test('record mappings retain metadata and native schema', async t => {
  const f = await fixture(t); const statePath = join(f.root, '.tasks/yougile.local-state.json');
  await atomicJson(statePath, { version: 1, tasks: { 'TASK-001': { yougileId: 'remote-1', fingerprint: 'original', annotation: 'keep' } } });
  await saveMappingEntry(statePath, 'TASK-003', 'new-id', 'new-fingerprint');
  const after = await json(statePath); assert.equal(after.version, 1);
  assert.deepEqual(after.tasks['TASK-001'], { yougileId: 'remote-1', fingerprint: 'original', annotation: 'keep' });
  assert.deepEqual(after.tasks['TASK-003'], { yougileId: 'new-id', fingerprint: 'new-fingerprint' });
  assert.deepEqual(decodeMapping(after).mapping, { 'TASK-001': 'remote-1', 'TASK-003': 'new-id' });
});
test('nested mapping duplicates fail before mutation', () => {
  assert.throws(() => decodeMapping({ tasks: { 'TASK-001': { yougileId: 'same' }, 'TASK-002': { yougileId: 'same' } } }), { code: 'DUPLICATE_MAPPING' });
});
test('native syncFromTaskId preserves already authorized closed-task selection', async t => {
  const f = await fixture(t); await atomicJson(join(f.root, '.tasks/yougile.local.json'), { ...f.config, syncFromTaskId: 'TASK-002' });
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api }); assert.equal(result.selected, 2); assert.equal(result.created, 1);
});
test('recovering a missing local mapping reuses the existing remote card', async t => {
  const f = await fixture(t); await atomicJson(join(f.root, '.tasks/yougile.local-state.json'), {});
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.created, 0); assert.equal(result.recovered, 1);
  assert.deepEqual(await json(join(f.root, '.tasks/yougile.local-state.json')), { 'TASK-001': 'remote-1' });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('missing record mapping with a changed payload uses PUT without creating a duplicate', async t => {
  const f = await fixture(t); await atomicJson(join(f.root, '.tasks/yougile.local-state.json'), { version: 1, tasks: {} });
  await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${section('TASK-001', 'Updated')}`);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(result.updated, 1); assert.equal(result.created, 0); assert.equal(result.recovered, 1);
  assert.equal((await json(join(f.root, '.tasks/yougile.local-state.json'))).tasks['TASK-001'].yougileId, 'remote-1');
});
test('null/deleted deadlines and HTML encoded descriptions compare semantically', () => {
  assert.equal(matchesOwned({}, { deadline: null }), true);
  assert.equal(matchesOwned({}, { deadline: { deleted: true } }), true);
  assert.equal(matchesOwned({ deadline: { startDate: 1, deadline: 2 } }, { deadline: null }), false);
  assert.equal(matchesOwned({ description: '&lt;test&gt;\r\nA &amp; B' }, { description: '<test>\nA & B' }), true);
});
test('lead-magnet and module stickers are both updated; client stickers retained', async t => {
  const f = await fixture(t); const config = { ...f.config, moduleStickerName: 'Модуль', leadMagnetStickerName: 'Лид-магнит' };
  await atomicJson(join(f.root, '.tasks/yougile.local.json'), config);
  await writeFile(join(f.root, 'tools/taskplanner-yougile-modules-core.mjs'), 'export const classifyTaskModule = () => ({module:{key:"product",name:"Product"}}); export const classifyLeadMagnet = () => ({definition:{key:"lm1",name:"LM1"}});');
  const request = f.api.request.bind(f.api); const list = f.api.list.bind(f.api);
  f.api.request = async (...args) => args[1].startsWith('/boards/') ? { id: 'b1', projectId: 'p1', stickers: { custom: { m1: true, l1: true } } } : request(...args);
  f.api.list = async (path, filters) => path === '/string-stickers' ? [filters.name === 'Модуль' ? { id: 'm1', name: 'Модуль', states: [{id:'ms',name:'Product'}] } : { id: 'l1', name: 'Лид-магнит', states: [{id:'ls',name:'LM1'}] }] : list(path, filters);
  const result = await syncProject(f.home, f.project, { apply: true, api: f.api }); assert.equal(result.updated, 1);
  assert.deepEqual(f.cards.get('remote-1').stickers, { 'client-sticker': 'retain', m1: 'ms', l1: 'ls' });
});
test('description transport preserves literal angle brackets and ampersands', () => {
  const original = { description: 'Keep <order[id]> & <example> and &lt;literal&gt;', columnId: 'same' };
  const sent = transportPayload(original);
  assert.equal(sent.description, 'Keep &lt;order[id]&gt; &amp; &lt;example&gt; and &amp;lt;literal&amp;gt;');
  assert.equal(matchesOwned({ description: sent.description, columnId: 'same' }, original), true);
  assert.equal(original.description, 'Keep <order[id]> & <example> and &lt;literal&gt;');
  assert.equal(sent.columnId, 'same');
});
test('HTML sanitization does not remove source examples or cause repeated updates', async t => {
  const f = await fixture(t); const body = section('TASK-001', 'Existing task', 'Literal <order[id]> & value');
  await writeFile(join(f.root, '.tasks/BACKLOG.md'), `# Backlog\n\n${body}`);
  const request = f.api.request.bind(f.api);
  f.api.request = (method, path, payload) => request(method, path, payload && { ...payload, description: payload.description?.replace(/<[^>]+>/g, '') });
  const first = await syncProject(f.home, f.project, { apply: true, api: f.api }); assert.equal(first.updated, 1);
  assert.match(f.cards.get('remote-1').description, /&lt;order\[id\]&gt;/);
  const audit = await syncProject(f.home, f.project, { apply: true, api: f.api, reconcile: true, maxWrites: 0 });
  assert.equal(audit.pending, 0); assert.equal(audit.adopted, 1);
});
test('read-only audit invalidates stale hashes so a later normal sync repairs remote drift', async t => {
  const f = await fixture(t); await syncProject(f.home, f.project, { apply: true, api: f.api });
  f.cards.get('remote-1').description = 'Remote drift';
  const audit = await syncProject(f.home, f.project, { apply: true, api: f.api, reconcile: true, maxWrites: 0 });
  assert.equal(audit.pending, 1);
  const repaired = await syncProject(f.home, f.project, { apply: true, api: f.api });
  assert.equal(repaired.updated, 1); assert.equal(repaired.pending, 0);
  const verified = await syncProject(f.home, f.project, { apply: true, api: f.api, reconcile: true, maxWrites: 0 });
  assert.equal(verified.pending, 0);
});
