import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CodexMcp } from './codex-mcp.mjs';
import { json, atomicJson, withLock, digest, iso, fail } from './storage.mjs';
import { refreshPassport, acknowledgePassport } from './passport-sync.mjs';

const runtime = dirname(dirname(fileURLToPath(import.meta.url)));
const file = (home, p) => join(home, 'passports', `${p.id}.sync.json`);
export const pageFingerprint = p => digest({ id: p.id, projectId: p.projectId, boardId: p.boardId, title: p.title, content: p.content });
export const canonicalMarkdown = value => value.replace(/\r\n/g, '\n').replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
export function markdownLinks(value) {
  const links = [...value.matchAll(/!?\[[^\]]*\]\((<?https?:\/\/[^\s)>]+>?)(?:\s+[^)]*)?\)/g)].map(m => m[1].replace(/^<|>$/g, ''));
  for (const m of value.matchAll(/\bhref=["']([^"']+)["']/g)) links.push(m[1]);
  return links;
}
async function policy(home, project, settings) {
  if (!settings.passports?.enabled || !settings.passports.publisherEnabled || settings.passports.publisher !== 'mcp' || !project.enabled || project.manuallyDisabled) fail('MCP_PASSPORT_POLICY', 'MCP passport publication is not enabled for this project.');
  const config = await json(join(project.path, '.tasks/yougile.local.json'));
  if (!config.projectId) fail('MCP_PROJECT', 'An existing YouGile project ID is required.');
  return { config, state: await json(file(home, project), {}) };
}
async function using(settings, client, fn) {
  const owned = !client;
  client ||= await new CodexMcp({ binary: settings.passports.mcp?.binary, server: settings.passports.mcp?.server || 'yougile', cwd: runtime }).start();
  try { return await fn(client); } finally { if (owned) await client.close(); }
}
async function boardTree(client, projectId) {
  const boards = []; let cursor = '';
  do {
    const result = await client.call('get_project_tree', { id: projectId, cursor, projectState: 'active' });
    for (const p of result.projects || []) {
      if (p.id !== projectId) fail('MCP_PROJECT', 'Remote project selection changed; no publication performed.');
      boards.push(...(p.boards || []).filter(b => b.type === 'knowledgeBase'));
    }
    cursor = result.nextCursor || '';
  } while (cursor);
  return boards;
}
async function listPages(client, boardId) {
  const pages = []; let cursor = null;
  do {
    const result = await client.call('kb_list_pages', { boardId, parentId: null, q: null, cursor });
    pages.push(...(result.pages || [])); cursor = result.nextCursor;
  } while (cursor);
  return pages;
}
export async function readMcpPage(client, id) {
  let page, cursor = null;
  do {
    const result = await client.call('kb_get_page', { id, cursor });
    if (!result.page || typeof result.page.content !== 'string') fail('MCP_PAGE', 'Knowledge-base page is unavailable.');
    if (!page) page = { ...result.page };
    else {
      if (page.id !== result.page.id || page.updatedAt !== result.page.updatedAt || page.boardId !== result.page.boardId || page.title !== result.page.title) fail('MCP_PAGE_CHANGED', 'Page changed during paginated reading; retry later.');
      page.content += result.page.content;
    }
    cursor = result.nextCursor;
  } while (cursor);
  return page;
}
function checkPage(page, projectId, boardId, pageId) {
  if (page.projectId !== projectId || page.boardId !== boardId || pageId && page.id !== pageId) fail('MCP_DESTINATION', 'Existing passport destination changed; no write performed.');
}
async function locate(client, project, config, state) {
  const binding = state.binding;
  if (binding?.pageId) {
    const page = await readMcpPage(client, binding.pageId);
    checkPage(page, config.projectId, binding.boardId, binding.pageId);
    return { page, boardId: binding.boardId };
  }
  const boards = await boardTree(client, config.projectId);
  let board;
  if (binding?.boardId) {
    board = boards.find(b => b.id === binding.boardId);
    if (!board) fail('MCP_DESTINATION', 'The bound knowledge-base board is missing; never create a replacement.');
  } else {
    const matches = [];
    for (const b of boards) for (const page of await listPages(client, b.id)) if (page.title === `Паспорт проекта — ${project.name}`) matches.push({ board: b, page });
    if (matches.length > 1) fail('MCP_AMBIGUOUS', 'Several project passports exist; preserve them and select the intended page.');
    if (matches.length === 1) {
      const page = await readMcpPage(client, matches[0].page.id);
      checkPage(page, config.projectId, matches[0].board.id);
      return { page, boardId: matches[0].board.id };
    }
    if (boards.length > 1) fail('MCP_AMBIGUOUS', 'Several knowledge bases exist; select the intended board.');
    board = boards[0];
  }
  if (!board) return { page: null, boardId: null };
  const pages = await listPages(client, board.id);
  const code = binding?.pageUrl?.split('/').at(-1);
  const matching = pages.filter(p => p.pageId === code || p.title === `Паспорт проекта — ${project.name}`);
  if (matching.length > 1) fail('MCP_AMBIGUOUS', 'Several passport pages match; preserve them for review.');
  if (!matching.length) {
    if (binding) fail('MCP_DESTINATION', 'The bound passport is missing; never create a replacement.');
    return { page: null, boardId: board.id };
  }
  const page = await readMcpPage(client, matching[0].id);
  checkPage(page, config.projectId, board.id);
  return { page, boardId: board.id };
}
function pageUrl(settings, state, page) {
  if (state.binding?.pageUrl) return state.binding.pageUrl;
  const base = settings.passports.mcp?.teamUrl;
  let url; try { url = new URL(base); } catch { fail('MCP_TEAM_URL', 'Configure the verified YouGile team URL before creating passports.'); }
  if (url.protocol !== 'https:' || !['ru.yougile.com', 'yougile.com'].includes(url.hostname) || !/^\/team\/[^/]+\/?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) fail('MCP_TEAM_URL', 'Use the verified HTTPS YouGile team URL.');
  if (!page.pageId) fail('MCP_PAGE', 'A human-readable page ID is required.');
  return base.replace(/\/$/, '') + '/' + encodeURIComponent(page.pageId);
}
export async function inspectMcpPassport(home, project, settings, { client } = {}) {
  const { config, state } = await policy(home, project, settings);
  return using(settings, client, async c => {
    const row = await refreshPassport(home, project, settings);
    const remote = await locate(c, project, config, state);
    const result = { ...row, boardId: remote.boardId, remote: remote.page, remoteFingerprint: remote.page ? pageFingerprint(remote.page) : null, baseline: state.baseline ?? null };
    if (remote.page) result.pageUrl = pageUrl(settings, state, remote.page);
    return result;
  });
}
export async function publishMcpPassport(home, project, settings, review, { apply = false, client } = {}) {
  // The reviewed candidate is produced by the agent after comparing local and remote facts.
  if (typeof review?.content !== 'string' || !review.content.trim() || review.content.length > 1_000_000) fail('MCP_REVIEW', 'A reviewed non-empty Markdown passport is required.');
  if (review.contentMode && !['replace', 'append', 'prepend'].includes(review.contentMode)) fail('MCP_REVIEW', 'Unsupported content mode.');
  if (!review.revision || !Object.hasOwn(review, 'remoteFingerprint')) fail('MCP_REVIEW', 'Review requires the local revision and remote fingerprint from inspection.');
  const run = async () => using(settings, client, async c => {
    const { config, state } = await policy(home, project, settings);
    const local = await refreshPassport(home, project, settings);
    if (local.revision !== review.revision) fail('PASSPORT_CHANGED', 'Local documents changed after review; review again.');
    let remote = await locate(c, project, config, state);
    if ((remote.page ? pageFingerprint(remote.page) : null) !== review.remoteFingerprint) fail('MCP_CONFLICT', 'Remote passport changed after review; preserve both versions and merge again.');
    const mode = review.contentMode || 'replace';
    if (!remote.page && mode !== 'replace') fail('MCP_REVIEW', 'New passports require complete content.');
    const expected = !remote.page || mode === 'replace' ? review.content : mode === 'append' ? remote.page.content + '\n\n' + review.content : review.content + '\n\n' + remote.page.content;
    const unchanged = remote.page && canonicalMarkdown(remote.page.content) === canonicalMarkdown(expected);
    if (!apply) return { project: project.name, mode: unchanged ? 'unchanged-preview' : remote.page ? 'update-preview' : 'create-preview', pageId: remote.page?.id, remoteWrites: unchanged ? 0 : remote.boardId ? 1 : 2, revision: local.revision };
    const checkLocal = async () => { if ((await refreshPassport(home, project, settings)).revision !== review.revision) fail('PASSPORT_CHANGED', 'Local documents changed before saving; review again.'); };
    const journal = join(home, 'passports', `${project.id}.mcp-write.json`);
    const previous = await json(journal, {});
    let backup;
    // Persist intent before creation. Unknown create outcomes are searched, never blindly repeated.
    if (!remote.page) {
      await checkLocal();
      pageUrl(settings, {}, { pageId: 'pending' }); // Validate company URL before any creation.
      if (previous.uncertainCreation && (!remote.boardId || previous.stage === 'page')) fail('MCP_CREATE_UNCERTAIN', 'An earlier creation has an unknown outcome. Search the same destination before retrying; do not duplicate it.');
      if (!remote.boardId) {
        await atomicJson(journal, { at: iso(), stage: 'board', uncertainCreation: true, projectId: config.projectId });
        const board = await c.call('create_board', { projectId: config.projectId, title: 'База знаний', columns: [], type: 'knowledgeBase' });
        remote.boardId = board.boardId;
        if (!remote.boardId) fail('MCP_CREATE', 'Knowledge-base creation returned no ID; inspect before retrying.');
      }
      await atomicJson(journal, { at: iso(), stage: 'page', uncertainCreation: true, projectId: config.projectId, boardId: remote.boardId });
      await c.call('kb_write_page', { id: null, boardId: remote.boardId, parentId: null, afterId: null, first: null, title: `Паспорт проекта — ${project.name}`, content: review.content, contentMode: 'replace', deleted: null });
      remote = await locate(c, project, config, {});
      if (!remote.page) fail('MCP_CREATE', 'Created passport has not appeared yet; leave its creation pending.');
    } else if (!unchanged) {
      backup = join(home, 'passports', `${project.id}.mcp-backup-${randomUUID()}.json`);
      const intent = { at: iso(), stage: 'update', page: remote.page, revision: local.revision, candidate: review.content, mode };
      await atomicJson(backup, intent);
      await atomicJson(journal, { ...intent, backup });
      // Re-read immediately before writing. YouGile does not expose an atomic conditional update.
      const latest = await readMcpPage(c, remote.page.id);
      if (pageFingerprint(latest) !== review.remoteFingerprint) fail('MCP_CONFLICT', 'Remote page changed before saving; manual changes preserved.');
      await checkLocal();
      await c.call('kb_write_page', { id: remote.page.id, boardId: null, parentId: null, afterId: null, first: null, title: null, content: review.content, contentMode: mode, deleted: null });
    }
    const verified = await readMcpPage(c, remote.page.id);
    checkPage(verified, config.projectId, remote.boardId, remote.page.id);
    if (verified.title !== remote.page.title || canonicalMarkdown(verified.content) !== canonicalMarkdown(expected)) fail('MCP_VERIFY', 'Saved passport differs from the reviewed text; keep the backup and pending review.');
    const url = pageUrl(settings, state, verified);
    await acknowledgePassport(home, project, settings, { revision: review.revision, pageUrl: url, boardId: verified.boardId, verifiedAt: iso(), remoteContent: verified.content, remoteLinks: markdownLinks(verified.content), pageId: verified.id, remoteFormat: 'markdown', publishedVia: 'YouGile MCP' }, { apply: true });
    await atomicJson(journal, { at: iso(), stage: 'verified', pageId: verified.id, pageUrl: url, remoteFingerprint: pageFingerprint(verified), uncertainCreation: false, ...(backup ? { backup } : {}) });
    return { project: project.name, mode: unchanged ? 'verified-unchanged' : 'published', pageId: verified.id, pageUrl: url, revision: review.revision, transport: 'mcp' };
  });
  return apply ? withLock(join(home, 'passports', `${project.id}.mcp.lock`), run) : run();
}
