import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshPassport, preparePassport, pendingPassports, acknowledgePassport } from '../lib/passport-sync.mjs';
import { atomicJson, json } from '../lib/storage.mjs';
import { onboard } from '../lib/onboarding.mjs';
import { scan, updateRegistry } from '../lib/registry.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'passport-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'hub'), path = join(base, 'projects', 'one');
  await mkdir(join(path, 'docs'), { recursive: true });
  const project = { id: 'one', name: 'One', path, enabled: true };
  const settings = { passports: { enabled: true, publisherEnabled: true } };
  const receipt = row => ({ revision: row.revision, pageUrl: 'https://ru.yougile.com/team/company/ONE-1', boardId: 'knowledge-board', verifiedAt: new Date().toISOString(), remoteContent: 'One\nReviewed visible content', remoteLinks: ['https://example.com/admin'] });
  return { base, home, path, project, settings, receipt };
}
test('preview is read-only; apply creates a draft exactly once and queues publication', async t => {
  const f = await fixture(t);
  assert.equal((await refreshPassport(f.home, f.project, f.settings)).needsCreation, true);
  await assert.rejects(readFile(join(f.path, 'docs/project-passport.md')), { code: 'ENOENT' });
  const first = await refreshPassport(f.home, f.project, f.settings, { apply: true });
  const original = await readFile(first.source);
  assert.equal(first.created, true);
  const next = await refreshPassport(f.home, f.project, f.settings, { apply: true });
  assert.equal(next.revision, first.revision); assert.equal(next.created, false);
  assert.deepEqual(await readFile(first.source), original);
});
test('existing passports and bindings are adopted without overwriting manual content', async t => {
  const f = await fixture(t), source = join(f.path, 'docs/project-passport.md');
  await writeFile(source, '# One\n\nManual addition');
  await atomicJson(join(f.home, 'passports/one.publication.json'), f.receipt({ revision: 'legacy' }));
  const row = await refreshPassport(f.home, f.project, f.settings, { apply: true });
  assert.equal(row.binding.boardId, 'knowledge-board'); assert.equal(row.mode, 'pending');
  assert.equal(await readFile(source, 'utf8'), '# One\n\nManual addition');
  const prepared = await preparePassport(f.home, f.project, f.settings, { apply: true });
  assert.match(await readFile(prepared.html, 'utf8'), /<h2>One<\/h2>/);
});
test('ack clears pending; significant docs and deletion requeue, task churn does not', async t => {
  const f = await fixture(t), row = await refreshPassport(f.home, f.project, f.settings, { apply: true });
  await acknowledgePassport(f.home, f.project, f.settings, f.receipt(row), { apply: true });
  assert.deepEqual(await pendingPassports(f.home, [f.project], f.settings), []);
  await writeFile(join(f.path, 'docs/current-task.md'), 'Task changed');
  assert.deepEqual(await pendingPassports(f.home, [f.project], f.settings), []);
  await writeFile(join(f.path, 'docs/integrations.md'), 'New confirmed integration');
  let pending = await pendingPassports(f.home, [f.project], f.settings);
  assert.equal(pending.length, 1); assert.deepEqual(pending[0].changed, ['docs/integrations.md']);
  await refreshPassport(f.home, f.project, f.settings, { apply: true });
  await refreshPassport(f.home, f.project, f.settings, { apply: true });
  assert.deepEqual((await pendingPassports(f.home, [f.project], f.settings))[0].changed, ['docs/integrations.md']);
  await acknowledgePassport(f.home, f.project, f.settings, f.receipt(pending[0]), { apply: true });
  await rm(join(f.path, 'docs/integrations.md'));
  assert.equal((await pendingPassports(f.home, [f.project], f.settings)).length, 1);
});
test('ack rejects stale revisions, missing verification and destination changes', async t => {
  const f = await fixture(t), row = await refreshPassport(f.home, f.project, f.settings, { apply: true });
  await assert.rejects(acknowledgePassport(f.home, f.project, f.settings, { ...f.receipt(row), remoteContent: '' }, { apply: true }), { code: 'PASSPORT_EVIDENCE' });
  await writeFile(row.source, '# Updated source');
  await assert.rejects(acknowledgePassport(f.home, f.project, f.settings, f.receipt(row), { apply: true }), { code: 'PASSPORT_CHANGED' });
  const next = await refreshPassport(f.home, f.project, f.settings, { apply: true });
  await acknowledgePassport(f.home, f.project, f.settings, f.receipt(next), { apply: true });
  await assert.rejects(acknowledgePassport(f.home, f.project, f.settings, { ...f.receipt(next), boardId: 'different' }, { apply: true }), { code: 'PASSPORT_REBIND' });
  for (const pageUrl of ['http://ru.yougile.com/team/x/y', 'https://evil.example/team/x/y', 'https://ru.yougile.com/team/x/y?key=secret']) await assert.rejects(acknowledgePassport(f.home, f.project, f.settings, { ...f.receipt(next), pageUrl }), { code: 'PASSPORT_BINDING' });
  assert.equal((await json(join(f.home, 'passports/one.sync.json'))).baseline.source, '# Updated source');
  assert.deepEqual((await json(join(f.home, 'passports/one.sync.json'))).baseline.remoteLinks, ['https://example.com/admin']);
});
test('disabled, report-only and manually disabled projects never create drafts', async t => {
  const f = await fixture(t);
  for (const p of [{ ...f.project, enabled: false }, { ...f.project, manuallyDisabled: true }]) assert.equal((await refreshPassport(f.home, p, f.settings, { apply: true })).mode, 'disabled');
  assert.equal((await refreshPassport(f.home, f.project, {}, { apply: true })).mode, 'disabled');
  await assert.rejects(readFile(join(f.path, 'docs/project-passport.md')), { code: 'ENOENT' });
});
test('missing project is never recreated and does not hide the rest of the queue', async t => {
  const f = await fixture(t), missing = { ...f.project, id: 'missing', path: join(f.base, 'unavailable') };
  await assert.rejects(refreshPassport(f.home, missing, f.settings, { apply: true }), { code: 'PASSPORT_PATH' });
  const queue = await pendingPassports(f.home, [missing, f.project], f.settings);
  assert.equal(queue[0].error.code, 'PASSPORT_PATH'); assert.equal(queue[1].mode, 'pending');
  await assert.rejects(readFile(join(missing.path, 'docs/project-passport.md')), { code: 'ENOENT' });
});
test('onboarding creates passport immediately and preserves it on repeated setup', async t => {
  const f = await fixture(t); await mkdir(join(f.path, '.tasks'));
  await atomicJson(join(f.path, '.tasks/config.json'), { states: [] });
  await scan(f.home, [join(f.base, 'projects')]);
  const settings = { ...f.settings, autoOnboarding: { enabled: true, roots: [join(f.base, 'projects')] } };
  const operations = Object.fromEntries(['activity', 'bridge', 'provision', 'sync'].map(k => [k, async () => {}]));
  operations.adopt = () => updateRegistry(f.home, r => { r.projects[0].enabled = true; });
  const result = await onboard(f.home, f.path, settings, { apply: true, operations });
  assert.equal(result.passport.created, true);
  await writeFile(join(f.path, 'docs/project-passport.md'), 'Manual changes');
  const again = await onboard(f.home, f.path, settings, { apply: true, operations });
  assert.equal(again.action, 'already-connected'); assert.equal(again.passport.created, false);
  assert.equal(await readFile(again.passport.source, 'utf8'), 'Manual changes');
});
