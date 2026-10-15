import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicJson, json } from '../lib/storage.mjs';
import { scan, findProject, updateRegistry } from '../lib/registry.mjs';
import { eligible, onboard, onboardDiscovered, registerAndOnboard, installBridge } from '../lib/onboarding.mjs';
import { newProjectConfig, provision, columnDefaults } from '../lib/provision.mjs';
import { fileURLToPath } from 'node:url';

async function fixture(t, configured = false) {
  const base = await mkdtemp(join(tmpdir(), 'hub-onboard-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'hub'), roots = join(base, 'projects'), path = join(roots, 'New project');
  await mkdir(join(path, '.tasks'), { recursive: true });
  await atomicJson(join(path, '.tasks/config.json'), { states: [] });
  if (configured) await atomicJson(join(path, '.tasks/yougile.local.json'), { workspaceKey: 'keep', boardId: 'keep-board' });
  await scan(home, [roots], 4);
  const project = await findProject(home, path);
  const settings = { autoOnboarding: { enabled: true, roots: [roots], profileFrom: 'approved-profile', assets: 'approved-assets' } };
  const calls = [];
  const operations = Object.fromEntries(['provision', 'bridge', 'sync'].map(name => [name, async () => { calls.push(name); }]));
  operations.adopt = async () => { calls.push('adopt'); await updateRegistry(home, r => { r.projects[0].enabled = true; }); };
  operations.activity = async () => {};
  return { base, home, roots, path, project, settings, calls, operations };
}

test('auto policy is opt-in, bounds paths and preserves manual exclusions', async t => {
  const f = await fixture(t), p = f.settings.autoOnboarding;
  assert.equal(await eligible(f.project, p), true);
  assert.equal(await eligible(f.project, {}), false);
  assert.equal(await eligible({ ...f.project, path: f.base }, p), false);
  assert.equal(await eligible({ ...f.project, path: f.roots }, p), false);
  assert.equal(await eligible({ ...f.project, manuallyDisabled: true }, p), false);
  assert.equal(await eligible(f.project, { ...p, excludedProjectIds: [f.project.id] }), false);
  assert.equal(await eligible({ ...f.project, path: join(f.base, 'missing-project') }, p), false);
  assert.equal(await eligible(f.project, { ...p, roots: [join(f.base, 'missing-root'), f.roots] }), true);
});

test('initialization preview never registers a project or performs operations', async t => {
  const f = await fixture(t), before = await readFile(join(f.home, 'registry.json'));
  assert.equal((await registerAndOnboard(f.home, f.path, f.settings)).action, 'onboard-preview');
  assert.equal((await onboard(f.home, f.path, f.settings)).action, 'connect-new-preview');
  assert.deepEqual(await readFile(join(f.home, 'registry.json')), before);
});

test('hook outside approved roots does not register or enable projects even with apply', async t => {
  const f = await fixture(t), before = await readFile(join(f.home, 'registry.json'));
  assert.equal((await registerAndOnboard(f.home, f.base, f.settings, { apply: true })).action, 'outside-auto-policy');
  assert.deepEqual(await readFile(join(f.home, 'registry.json')), before);
});

test('new project connects, installs bridge, adopts and syncs exactly once', async t => {
  const f = await fixture(t), options = { apply: true, operations: f.operations };
  assert.equal((await onboard(f.home, f.path, f.settings, options)).action, 'connected');
  assert.deepEqual(f.calls, ['provision', 'bridge', 'adopt', 'sync']);
  assert.equal((await onboard(f.home, f.path, f.settings, options)).action, 'already-connected');
  assert.equal(f.calls.length, 4);
});

test('existing connection is adopted without provisioning or changing its config', async t => {
  const f = await fixture(t, true), before = await readFile(join(f.path, '.tasks/yougile.local.json'));
  await onboard(f.home, f.path, f.settings, { apply: true, operations: f.operations });
  assert.deepEqual(f.calls, ['bridge', 'adopt', 'sync']);
  assert.deepEqual(await readFile(join(f.path, '.tasks/yougile.local.json')), before);
});

test('hourly discovery retries pending setup and does not re-enable paused projects', async t => {
  const f = await fixture(t), options = { apply: true, operations: { ...f.operations, provision: async () => { throw new Error('secret must never appear'); } } };
  const result = await onboardDiscovered(f.home, f.settings, options);
  assert.equal(result[0].action, 'pending');
  assert.equal(JSON.stringify(result).includes('secret must never appear'), false);
  assert.equal((await findProject(f.home, f.path)).onboarding.state, 'pending');
  assert.equal((await onboardDiscovered(f.home, f.settings, { apply: true, operations: f.operations }))[0].action, 'connected');
  await updateRegistry(f.home, r => { r.projects[0].enabled = false; r.projects[0].manuallyDisabled = true; });
  assert.deepEqual(await onboardDiscovered(f.home, f.settings, { apply: true, operations: f.operations }), []);
});

test('bridge preserves original connector and unmanaged docs, uses requested home, is repeatable', async t => {
  const f = await fixture(t, true);
  await mkdir(join(f.path, 'tools')); await mkdir(join(f.path, 'docs'));
  const original = '// original customized connector\r\n';
  await writeFile(join(f.path, 'tools/taskplanner-yougile-sync.mjs'), original);
  await writeFile(join(f.path, 'AGENTS.md'), '# Existing instructions\r\n');
  await writeFile(join(f.path, 'docs/integrations.md'), '# Existing docs\r\n');
  await installBridge(f.home, f.project, {});
  const after = await readFile(join(f.path, 'tools/taskplanner-yougile-sync.mjs'), 'utf8');
  assert.equal(after.endsWith(original), true);
  assert.equal((await json(join(f.path, '.tasks/yougile.hub.local.json'))).home, f.home);
  const docs = await readFile(join(f.path, 'docs/integrations.md'), 'utf8');
  assert.equal(docs.startsWith('# Existing docs\r\n'), true);
  assert.match(docs, /раз в час/);
  await installBridge(f.home, f.project, {});
  assert.equal(await readFile(join(f.path, 'docs/integrations.md'), 'utf8'), docs);
  assert.equal(await readFile(join(f.path, 'tools/taskplanner-yougile-sync.mjs'), 'utf8'), after);
});

test('skill hook previews offline and invokes the configured CLI after apply only', async t => {
  const f = await fixture(t), cli = join(f.base, 'fake-cli.mjs'), log = join(f.base, 'called.json');
  await writeFile(cli, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({action:'connected'}));`);
  const pointer = join(f.base, 'pointer.json');
  await atomicJson(pointer, { enabled: true, node: process.execPath, cli, home: f.home });
  const script = 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from project_hub_hook import run_hub_hook;run_hub_hook(Path(sys.argv[2]),sys.argv[3]=="apply")';
  const run = mode => spawnSync('python', ['-c', script, fileURLToPath(new URL('../../../scripts/', import.meta.url)), f.path, mode], { encoding: 'utf8', env: { ...process.env, PROJECT_TASK_HUB_POINTER: pointer } });
  assert.match(run('preview').stdout, /after apply/);
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  assert.match(run('apply').stdout, /connected/);
  assert.deepEqual(await json(log), ['onboard', '--home', f.home, '--project', f.path, '--apply']);
});

test('project bridge records a local note through the shared CLI without YouGile', async t => {
  const f = await fixture(t, true); await mkdir(join(f.path, 'tools'));
  await writeFile(join(f.path, 'tools/taskplanner-yougile-sync.mjs'), '// original\n');
  await installBridge(f.home, f.project, {});
  const bridge = join(f.path, 'tools/taskplanner-yougile-hub.mjs');
  const child = spawnSync(process.execPath, [bridge, 'log', '--kind', 'research', '--summary', 'Confirmed local result', '--apply'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).mode, 'recorded');
  assert.equal((await json(join(f.home, `activity-${f.project.id}.json`))).events[0].summary, 'Confirmed local result');
});

test('new project inherits the approved calendar, not project IDs or categories', () => {
  const profile = { baseUrl: 'https://yougile.com/api-v2', apiKeyFile: '../../private/key.txt', workspaceKey: 'old', projectId: 'old-project', boardId: 'old-board',
    workday: { startHour: 9, hours: 8, timezoneOffsetMinutes: -240 }, historyTimeZone: 'America/New_York', defaultEstimate: 'S',
    estimateHours: { M: 8 }, modules: [{ name: 'Specific product' }], moduleStickerName: 'Specific sticker' };
  const result = newProjectConfig(profile, resolve('example-profile'), { workspaceKey: 'new', projectId: 'new-project', boardId: 'new-board', columns: { Backlog: 'new-column' } });
  assert.deepEqual(result.workday, profile.workday);
  assert.equal(result.historyTimeZone, 'America/New_York');
  assert.equal(result.estimateHours.M, 8);
  assert.equal(result.projectId, 'new-project');
  assert.deepEqual(result.modules, []);
  assert.equal(result.moduleStickerName, null);
  assert.equal(result.apiKeyFile, resolve('example-profile', '../../private/key.txt'));
  result.workday.hours = 4;
  assert.equal(profile.workday.hours, 8);
});

test('provision validates approved profile before POST and retries with stable destinations', async t => {
  const f = await fixture(t), profile = join(f.roots, 'profile');
  await mkdir(join(profile, '.tasks'), { recursive: true });
  await atomicJson(join(f.path, '.tasks/config.json'), { states: columnDefaults.map(([name]) => ({ name })) });
  const columns = Object.fromEntries(columnDefaults.map(([name], i) => [name, `old-col-${i}`]));
  await atomicJson(join(profile, '.tasks/yougile.local.json'), { baseUrl: 'https://yougile.com/api-v2', workspaceKey: 'old', projectId: 'old-project', boardId: 'old-board', columns });
  const calls = [], createdColumns = [], boards = [];
  let valid = false;
  const api = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/boards/old-board') return { id: 'old-board', projectId: valid ? 'old-project' : 'wrong-company' };
      if (method === 'GET' && path === '/boards/new-board') return boards[0];
      if (method === 'POST' && path === '/projects') return { id: 'new-project' };
      if (method === 'POST' && path === '/boards') { boards.push({ id: 'new-board', ...body }); return boards[0]; }
      if (method === 'POST' && path === '/columns') { const value = { id: `new-col-${createdColumns.length}`, ...body }; createdColumns.push(value); return value; }
      throw new Error('Unexpected request');
    },
    async list(path, filters) {
      if (path === '/columns') return filters.boardId === 'old-board' ? Object.values(columns).map(id => ({ id, boardId: 'old-board' })) : createdColumns;
      if (path === '/projects') return [];
      if (path === '/boards') return boards;
      throw new Error('Unexpected list');
    },
  };
  const assets = fileURLToPath(new URL('../vendor/yougile/', import.meta.url));
  await assert.rejects(provision(f.home, f.path, profile, assets, { apply: true, api }), { code: 'REMOTE_BOARD' });
  assert.equal(calls.some(c => c.method === 'POST'), false);
  valid = true;
  const result = await provision(f.home, f.path, profile, assets, { apply: true, api });
  assert.equal(result.action, 'connected');
  assert.equal(createdColumns.length, 5);
  assert.equal((await json(join(f.path, '.tasks/yougile.local.json'))).boardId, 'new-board');
  const before = calls.length;
  assert.equal((await provision(f.home, f.path, profile, assets, { apply: true, api })).action, 'preserve-existing-config');
  assert.equal(calls.length, before);
  assert.equal(calls.filter(c => c.method === 'POST').every(c => !!c.body.idempotencyKey), true);
});
