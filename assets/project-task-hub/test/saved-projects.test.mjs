import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSavedProjects, initializeProject, discoveryDue } from '../lib/saved-projects.mjs';
import { atomicJson, json } from '../lib/storage.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'saved-projects-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), projects = join(root, 'projects'); await mkdir(projects);
  const settings = { autoOnboarding: { enabled: true, roots: [projects], savedProjects: { enabled: true } } };
  const saved = [], list = async () => saved;
  const add = async (name, parent = projects) => { const path = join(parent, name); await mkdir(path, { recursive: true }); saved.push({ id: name, roots: [{ path }] }); return path; };
  return { root, home, projects, settings, saved, add, options: { list, apply: true } };
}
test('hourly discovery tolerates a slow prior tick and scheduler jitter without skipping an hour', () => {
  assert.equal(discoveryDue('2026-10-24T08:45:00Z', Date.parse('2026-10-24T09:42:00Z')), true);
  assert.equal(discoveryDue('2026-10-24T09:42:00Z', Date.parse('2026-10-24T09:55:00Z')), false);
  assert.equal(discoveryDue('invalid', Date.parse('2026-10-24T09:42:00Z')), true);
});
test('baseline preserves old unconfigured projects; future saved projects initialize once and register', async t => {
  const f = await fixture(t), old = await f.add('Existing');
  assert.equal((await discoverSavedProjects(f.home, f.settings, { ...f.options, apply: false })).mode, 'baseline-preview');
  await assert.rejects(readFile(f.home), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.home, 'saved-projects.json')), { code: 'ENOENT' });
  assert.equal((await discoverSavedProjects(f.home, f.settings, f.options)).mode, 'baseline-saved');
  const next = await f.add('New'); await writeFile(join(next, 'AGENTS.md'), '# Manual rules\r\n');
  const result = await discoverSavedProjects(f.home, f.settings, f.options);
  assert.equal(result.results[0].mode, 'initialized'); assert.equal(result.pending, 0);
  await assert.rejects(readFile(join(old, '.tasks/config.json')), { code: 'ENOENT' });
  assert.equal((await json(join(next, '.tasks/config.json'))).states.length, 5);
  const after = await readFile(join(next, 'AGENTS.md'), 'utf8'); assert.ok(after.startsWith('# Manual rules\r\n'));
  assert.equal((await json(join(f.home, 'registry.json'))).projects.length, 1);
  assert.deepEqual((await discoverSavedProjects(f.home, f.settings, f.options)).results, []);
  await initializeProject(f.home, next); assert.equal(await readFile(join(next, 'AGENTS.md'), 'utf8'), after);
});
test('outside roots, nested saved directories and output folders never become projects', async t => {
  const f = await fixture(t); await discoverSavedProjects(f.home, f.settings, f.options);
  const parent = await f.add('Parent'); await f.add('Nested', parent); const out = await f.add('Outside', f.root); const output = await f.add('output');
  const result = await discoverSavedProjects(f.home, f.settings, f.options);
  assert.equal(result.results.length, 1); assert.equal(result.results[0].path, parent);
  for (const path of [join(parent, 'Nested'), out, output]) await assert.rejects(readFile(join(path, '.tasks/config.json')), { code: 'ENOENT' });
});
test('failed initialization remains queued and retries; unavailable inventory never seeds a false baseline', async t => {
  const f = await fixture(t);
  const failure = await discoverSavedProjects(f.home, f.settings, { ...f.options, list: async () => { throw new Error('secret diagnostic'); } });
  assert.equal(failure.mode, 'unavailable'); assert.ok(!JSON.stringify(failure).includes('secret diagnostic'));
  await assert.rejects(readFile(join(f.home, 'saved-projects.json')), { code: 'ENOENT' });
  await discoverSavedProjects(f.home, f.settings, f.options); const path = await f.add('Retry');
  assert.equal((await discoverSavedProjects(f.home, f.settings, { ...f.options, initialize: async () => { throw new Error(); } })).pending, 1);
  assert.equal((await discoverSavedProjects(f.home, f.settings, f.options)).pending, 0);
  await readFile(join(path, '.tasks/config.json'));
});
test('manual disable and existing task content survive discovery; partial boards require review', async t => {
  const f = await fixture(t); await discoverSavedProjects(f.home, f.settings, f.options);
  const path = await f.add('Paused'); await initializeProject(f.home, path);
  const { scan } = await import('../lib/registry.mjs'); await scan(f.home, [path], 0);
  const registry = await json(join(f.home, 'registry.json')); registry.projects[0].manuallyDisabled = true; await atomicJson(join(f.home, 'registry.json'), registry);
  const before = await readFile(join(path, '.tasks/config.json'));
  assert.deepEqual((await discoverSavedProjects(f.home, f.settings, f.options)).results, []);
  assert.deepEqual(await readFile(join(path, '.tasks/config.json')), before);
  const partial = await f.add('Partial'); await mkdir(join(partial, '.tasks')); await writeFile(join(partial, '.tasks/DONE.md'), 'Existing tasks');
  await assert.rejects(initializeProject(f.home, partial), { code: 'SAVED_PROJECT_PARTIAL' });
  assert.equal(await readFile(join(partial, '.tasks/DONE.md'), 'utf8'), 'Existing tasks');
});
