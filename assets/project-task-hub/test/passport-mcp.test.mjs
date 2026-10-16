import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, json } from '../lib/storage.mjs';
import { refreshPassport, pendingPassports } from '../lib/passport-sync.mjs';
import { inspectMcpPassport, publishMcpPassport, readMcpPage } from '../lib/passport-mcp.mjs';
import { CodexMcp } from '../lib/codex-mcp.mjs';

async function fixture(t, { existing = true, board = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passport-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), path = join(root, 'project');
  await mkdir(join(path, 'docs'), { recursive: true });
  await atomicJson(join(path, '.tasks/yougile.local.json'), { projectId: 'project' });
  await writeFile(join(path, 'docs/project-passport.md'), '# One\n\nLocal fact');
  const project = { id: 'one', name: 'One', path, enabled: true };
  const settings = { passports: { enabled: true, publisherEnabled: true, publisher: 'mcp', mcp: { teamUrl: 'https://ru.yougile.com/team/company' } } };
  const remote = { id: 'page', pageId: 'ONE-1', title: 'Паспорт проекта — One', projectId: 'project', boardId: 'kb', updatedAt: 'original', content: '# One\n\n[Admin](https://example.com/control)\n\nManual addition' };
  const calls = [], pages = existing ? [remote] : [], boards = board ? [{ id: 'kb', type: 'knowledgeBase' }] : [];
  const client = { async call(tool, args) {
    calls.push({ tool, args });
    if (tool === 'get_project_tree') return { projects: [{ id: 'project', boards: [{ id: 'tasks' }, ...boards] }], nextCursor: null };
    if (tool === 'kb_list_pages') return { pages: pages.filter(p => p.boardId === args.boardId).map(p => ({ ...p })), nextCursor: null };
    if (tool === 'kb_get_page') {
      const p = pages.find(p => p.id === args.id); if (!p) throw Object.assign(new Error(), { code: 'MISSING' });
      return { page: { ...p }, nextCursor: null };
    }
    if (tool === 'create_board') { assert.equal(args.type, 'knowledgeBase'); assert.deepEqual(args.columns, []); boards.push({ id: 'kb', type: 'knowledgeBase' }); return { boardId: 'kb' }; }
    if (tool === 'kb_write_page') {
      assert.equal(args.deleted, null); assert.equal(args.parentId, null); assert.equal(args.afterId, null);
      if (!args.id) { pages.push({ ...remote, content: args.content }); return { id: 'page', pageId: 'ONE-1' }; }
      assert.equal(args.id, 'page'); assert.equal(args.title, null); assert.equal(args.boardId, null);
      const p = pages[0]; p.content = args.contentMode === 'append' ? p.content + '\n\n' + args.content : args.contentMode === 'prepend' ? args.content + '\n\n' + p.content : args.content;
      p.updatedAt = 'changed'; return { id: p.id, pageId: p.pageId };
    }
    throw new Error(tool);
  } };
  const writes = () => calls.filter(c => ['kb_write_page', 'create_board'].includes(c.tool));
  await refreshPassport(home, project, settings, { apply: true });
  const inspect = () => inspectMcpPassport(home, project, settings, { client });
  const publish = (review, apply = true) => publishMcpPassport(home, project, settings, review, { client, apply });
  const review = async content => { const r = await inspect(); return { revision: r.revision, remoteFingerprint: r.remoteFingerprint, content: content ?? r.remote?.content ?? '# One' }; };
  return { home, path, project, settings, remote, pages, client, calls, writes, inspect, publish, review };
}
test('MCP adoption and no-op retain existing URL, ID, manual text and links without a write', async t => {
  const f = await fixture(t);
  await atomicJson(join(f.home, 'passports/one.publication.json'), { pageUrl: 'https://ru.yougile.com/team/company/kb-legacy', boardId: 'kb' });
  await refreshPassport(f.home, f.project, f.settings, { apply: true });
  const result = await f.publish(await f.review());
  assert.equal(result.pageUrl, 'https://ru.yougile.com/team/company/kb-legacy'); assert.equal(result.mode, 'verified-unchanged'); assert.equal(f.writes().length, 0);
  const state = await json(join(f.home, 'passports/one.sync.json'));
  assert.equal(state.binding.pageId, 'page'); assert.equal(state.baseline.remoteFormat, 'markdown');
  assert.equal(state.baseline.remoteContent, f.remote.content); assert.deepEqual(state.baseline.remoteLinks, ['https://example.com/control']);
  assert.deepEqual(await pendingPassports(f.home, [f.project], f.settings), []);
});
test('MCP preview is read-only; append retains manual content and readback clears queue', async t => {
  const f = await fixture(t), before = f.remote.content, review = { ...await f.review('New verified fact'), contentMode: 'append' };
  assert.equal((await f.publish(review, false)).remoteWrites, 1); assert.equal(f.writes().length, 0);
  await f.publish(review); assert.equal(f.remote.content, before + '\n\nNew verified fact'); assert.equal(f.writes().length, 1);
  const saved = await json(join(f.home, 'passports/one.mcp-write.json'));
  assert.equal((await json(saved.backup)).page.content, before);
});
test('local or remote changes after review prevent writes', async t => {
  const f = await fixture(t), review = await f.review('Updated');
  f.remote.content += '\nHuman change';
  await assert.rejects(f.publish(review), { code: 'MCP_CONFLICT' }); assert.equal(f.writes().length, 0);
  const next = await f.review('Updated'); await writeFile(join(f.path, 'docs/product.md'), 'New source');
  await assert.rejects(f.publish(next), { code: 'PASSPORT_CHANGED' }); assert.equal(f.writes().length, 0);
});
test('second remote read detects edits immediately before saving', async t => {
  const f = await fixture(t), review = await f.review('Updated'), original = f.client.call; let reads = 0;
  f.client.call = async (tool, args) => { if (tool === 'kb_get_page' && ++reads === 2) f.remote.content += '\nHuman change'; return original(tool, args); };
  await assert.rejects(f.publish(review), { code: 'MCP_CONFLICT' }); assert.equal(f.writes().length, 0);
});
test('bound missing or moved pages never cause replacement creation', async t => {
  const f = await fixture(t); await f.publish(await f.review());
  f.remote.projectId = 'other'; await assert.rejects(f.inspect(), { code: 'MCP_DESTINATION' });
  f.pages.splice(0); await assert.rejects(f.inspect(), { code: 'MISSING' }); assert.equal(f.writes().length, 0);
});
test('new passport creates native KB once; repeated publication reuses it and task board survives', async t => {
  const f = await fixture(t, { existing: false, board: false }), review = await f.review('# One\n\nNew confirmed facts');
  assert.equal((await f.publish(review, false)).remoteWrites, 2); assert.equal(f.writes().length, 0);
  await f.publish(review); await f.publish(await f.review());
  assert.equal(f.writes().length, 2); assert.equal(f.pages.length, 1);
  assert.ok((await f.client.call('get_project_tree', {})).projects[0].boards.some(b => b.id === 'tasks'));
});
test('unknown create outcome is searched and adopted, never blindly retried', async t => {
  const f = await fixture(t, { existing: false }), original = f.client.call, review = await f.review('# One');
  f.client.call = async (tool, args) => { const r = await original(tool, args); if (tool === 'kb_write_page') throw Object.assign(new Error(), { code: 'MCP_TIMEOUT' }); return r; };
  await assert.rejects(f.publish(review), { code: 'MCP_TIMEOUT' });
  f.client.call = original; await f.publish(await f.review()); assert.equal(f.writes().length, 1); assert.equal(f.pages.length, 1);
});
test('unknown creation with no visible page stays pending and does not create a duplicate', async t => {
  const f = await fixture(t, { existing: false }), original = f.client.call, review = await f.review('# One');
  f.client.call = async (tool, args) => { if (tool === 'kb_write_page') throw Object.assign(new Error(), { code: 'MCP_TIMEOUT' }); return original(tool, args); };
  await assert.rejects(f.publish(review), { code: 'MCP_TIMEOUT' });
  f.client.call = original; await assert.rejects(f.publish(review), { code: 'MCP_CREATE_UNCERTAIN' }); assert.equal(f.writes().length, 0);
});
test('readback mismatch keeps pending state and a full remote backup', async t => {
  const f = await fixture(t), original = f.client.call, before = f.remote.content, review = await f.review('Updated');
  f.client.call = async (tool, args) => { const r = await original(tool, args); if (tool === 'kb_write_page') f.remote.content = 'Unexpected server result'; return r; };
  await assert.rejects(f.publish(review), { code: 'MCP_VERIFY' });
  assert.equal((await json(join(f.home, 'passports/one.sync.json'))).pending, true);
  assert.equal((await json(join(f.home, 'passports/one.mcp-write.json'))).page.content, before);
});
test('pagination rejects a page that changes between chunks', async () => {
  const client = { call: async (_, args) => ({ page: { id: 'one', boardId: 'kb', title: 'One', updatedAt: args.cursor ? 'new' : 'old', content: 'part' }, nextCursor: args.cursor ? null : 'next' }) };
  await assert.rejects(readMcpPage(client, 'one'), { code: 'MCP_PAGE_CHANGED' });
});
test('transport rejects deletion, moving pages, task boards and unrelated tools before sending', async () => {
  const client = new CodexMcp(); client.request = () => { throw new Error('Must not send'); };
  for (const [tool, args] of [['kb_write_page', { id: 'page', deleted: true }], ['kb_write_page', { id: 'page', boardId: 'other' }], ['create_board', { type: 'board', columns: [] }], ['create_task', {}]]) await assert.rejects(client.call(tool, args), { code: 'MCP_SCOPE' });
});
