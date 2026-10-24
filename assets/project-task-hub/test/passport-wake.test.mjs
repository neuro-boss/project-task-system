import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json } from '../lib/storage.mjs';
import { refreshPassport, acknowledgePassport } from '../lib/passport-sync.mjs';
import { wakePassports, transitionWake, queueCodex } from '../lib/passport-wake.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'passport-wake-')); t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), root = join(base, 'runtime'), path = join(base, 'project');
  await mkdir(join(path, 'docs'), { recursive: true }); await mkdir(root);
  await writeFile(join(path, 'docs/project-passport.md'), '# One\n\nFacts');
  const projects = [{ id: 'one', name: 'One', path, enabled: true }];
  const settings = { passports: { enabled: true, publisherEnabled: true, publisher: 'mcp', wake: { enabled: true, binary: 'codex', threadId: '11111111-1111-1111-1111-111111111111' } } };
  const sent = [], dispatch = async x => sent.push(x);
  const wake = options => wakePassports(home, projects, settings, { root, dispatch, apply: true, ...options });
  const clear = async () => { const row = await refreshPassport(home, projects[0], settings, { apply: true }); await acknowledgePassport(home, projects[0], settings, { revision: row.revision, pageUrl: 'https://ru.yougile.com/team/company/ONE-1', boardId: 'kb', remoteContent: 'Facts', remoteLinks: [], verifiedAt: new Date().toISOString() }, { apply: true }); };
  return { home, root, path, projects, settings, sent, wake, clear };
}
test('empty queue never dispatches or writes a wake receipt, even with invalid CLI settings', async t => {
  const f = await fixture(t); await f.clear(); f.settings.passports.wake.binary = null;
  assert.equal((await f.wake()).mode, 'empty'); assert.equal(f.sent.length, 0);
  await assert.rejects(readFile(join(f.home, 'passports/wake.json')), { code: 'ENOENT' });
});
test('nonempty preview is read-only; apply queues once and repeated/changed work coalesces', async t => {
  const f = await fixture(t);
  assert.equal((await f.wake({ apply: false })).mode, 'wake-preview'); assert.equal(f.sent.length, 0);
  const first = await f.wake(); assert.equal(first.mode, 'queued'); assert.equal(f.sent.length, 1);
  await writeFile(join(f.path, 'docs/product.md'), 'Another update');
  assert.equal((await f.wake()).mode, 'queued-existing'); assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].message.includes('--wake-start ' + first.id)); assert.ok(f.sent[0].message.includes('--wake-finish ' + first.id));
  assert.equal(f.sent[0].threadId, f.settings.passports.wake.threadId);
});
test('worker claims once, finish allows the next hourly retry only if work remains', async t => {
  const f = await fixture(t), first = await f.wake();
  assert.equal((await transitionWake(f.home, first.id, 'start', { apply: true })).mode, 'started');
  assert.equal((await transitionWake(f.home, first.id, 'start', { apply: true })).mode, 'busy');
  assert.equal((await f.wake()).mode, 'running'); assert.equal(f.sent.length, 1);
  await transitionWake(f.home, first.id, 'finish', { apply: true });
  const retry = await f.wake(); assert.equal(retry.mode, 'queued'); assert.notEqual(retry.id, first.id);
  assert.equal((await transitionWake(f.home, first.id, 'start', { apply: true })).mode, 'stale');
  await f.clear(); assert.equal((await f.wake()).mode, 'empty'); assert.equal(f.sent.length, 2);
});
test('quick worker can claim/finish while dispatch is returning without a lock deadlock or overwritten status', async t => {
  const f = await fixture(t);
  await f.wake({ dispatch: async () => { const s = await json(join(f.home, 'passports/wake.json')); await transitionWake(f.home, s.id, 'start', { apply: true }); await transitionWake(f.home, s.id, 'finish', { apply: true }); } });
  assert.equal((await json(join(f.home, 'passports/wake.json'))).status, 'finished');
});
test('unknown dispatch outcome stays pending without hourly duplicate requests', async t => {
  const f = await fixture(t); let count = 0;
  const dispatch = async () => { count++; throw Object.assign(new Error('private diagnostic'), { killed: true }); };
  assert.equal((await f.wake({ dispatch })).mode, 'uncertain'); assert.equal((await f.wake({ dispatch })).mode, 'uncertain'); assert.equal(count, 1);
  assert.ok(!(await readFile(join(f.home, 'passports/wake.json'), 'utf8')).includes('private diagnostic'));
});
test('known launch failure retries later and never clears passport work', async t => {
  const f = await fixture(t);
  assert.equal((await f.wake({ dispatch: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } })).mode, 'not-sent');
  assert.equal((await f.wake()).mode, 'queued'); assert.equal(f.sent.length, 1);
});
test('interrupted running worker can be retried after lease expiry', async t => {
  const f = await fixture(t), now = Date.now(), first = await f.wake({ now });
  await transitionWake(f.home, first.id, 'start', { apply: true, now });
  assert.equal((await f.wake({ now: now + 60_000 })).mode, 'running');
  assert.equal((await f.wake({ now: now + 3 * 3_600_000 })).mode, 'queued'); assert.equal(f.sent.length, 2);
});
test('disabled publisher, manual pause, unavailable projects and invalid targets never launch an agent', async t => {
  const f = await fixture(t);
  f.projects[0].manuallyDisabled = true; assert.equal((await f.wake()).mode, 'empty');
  f.projects[0].manuallyDisabled = false; f.settings.passports.publisherEnabled = false; assert.equal((await f.wake()).mode, 'disabled');
  f.settings.passports.publisherEnabled = true; f.settings.passports.wake.threadId = 'not-an-existing-uuid';
  await assert.rejects(f.wake(), { code: 'PASSPORT_WAKE_CONFIG' });
  f.projects[0].path = join(f.root, 'unavailable'); assert.equal((await f.wake()).mode, 'unavailable'); assert.equal(f.sent.length, 0);
});
test('CLI transport uses literal arguments, hidden process and no approval bypass flags', async () => {
  const message = 'Literal "text" with $() and `symbols`';
  await queueCodex({ binary: 'codex.exe', threadId: 'chat', message, cwd: 'project' }, async (binary, args, options) => {
    assert.equal(binary, 'codex.exe'); assert.deepEqual(args, ['queue', '--thread', 'chat', '--message', message]);
    assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
  }, async value => value);
});
