import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, json, atomicJson, withLock, iso, fail, safeError } from './storage.mjs';
import { renderMarkdown } from './markdown.mjs';

// Only these documents trigger a semantic review. Task churn and secrets are excluded.
export const passportInputs = ['docs/project-passport.md', 'README.md', 'docs/product.md', 'docs/architecture.md', 'docs/integrations.md', 'docs/deployment.md', 'docs/decisions.md'];
const statePath = (home, p) => join(home, 'passports', `${p.id}.sync.json`);
const active = (p, settings) => settings.passports?.enabled === true && p.enabled && !p.manuallyDisabled;
async function sourceText(project, name) {
  // Do not follow a symlink in any source path component.
  let path = project.path;
  for (const part of name.split('/')) {
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) fail('PASSPORT_SYMLINK', 'Passport sources must be regular project files.'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  return readFile(path, 'utf8');
}
async function inputs(project) {
  const hashes = {};
  for (const name of passportInputs) {
    const content = await sourceText(project, name);
    hashes[name] = digest({ present: content !== null, content });
  }
  return hashes;
}
function validateBinding(value) {
  let url;
  try { url = new URL(value.pageUrl); } catch { fail('PASSPORT_BINDING', 'A verified YouGile page URL is required.'); }
  if (url.protocol !== 'https:' || !['yougile.com', 'ru.yougile.com'].includes(url.hostname) || !/^\/team\/[^/]+\/[^/]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash || !value.boardId) fail('PASSPORT_BINDING', 'Use the observed page URL and knowledge-base board ID.');
}
export async function refreshPassport(home, project, settings, { apply = false } = {}) {
  if (!active(project, settings)) return { project: project.name, mode: 'disabled' };
  const run = async () => {
    const root = await lstat(project.path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!root?.isDirectory()) fail('PASSPORT_PATH', 'Project directory is unavailable; it was not recreated.');
    const missing = await sourceText(project, passportInputs[0]) === null;
    if (missing && apply) {
      const folder = join(project.path, 'docs'); await mkdir(folder, { recursive: true });
      const name = project.name.replace(/[\r\n#]/g, ' ');
      const text = `# Паспорт проекта — ${name}\n\nСоздано: ${iso().slice(0, 10)}. Черновик: факты требуют проверки по документам проекта.\n\n## Назначение\n\nПока не подтверждено. Источник для заполнения: README.md и docs/product.md.\n\n## Ссылки и окружения\n\nПубличный адрес, вход в админку и репозиторий пока не подтверждены. Не переносить ключи и приватные адреса.\n\n## Интеграции и эксплуатация\n\nПроверить docs/integrations.md, docs/architecture.md и docs/deployment.md.\n\n## Правила обновления\n\nОбновлять подтверждённые ссылки и важные факты с датой и источником. Сохранять ручные дополнения в существующей странице базы знаний YouGile.\n`;
      try { await writeFile(join(folder, 'project-passport.md'), text, { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const hashes = await inputs(project), revision = digest(hashes);
    const state = await json(statePath(home, project), {});
    const legacy = await json(join(home, 'passports', `${project.id}.publication.json`), {});
    let binding = state.binding;
    if (!binding && legacy.pageUrl) { validateBinding(legacy); binding = { pageUrl: legacy.pageUrl, boardId: legacy.boardId }; }
    const changed = passportInputs.filter(name => state.reviewedInputs?.[name] !== hashes[name]);
    const pending = state.reviewedRevision !== revision;
    const result = { project: project.name, id: project.id, path: project.path, mode: pending ? 'pending' : 'unchanged', revision, created: missing && apply, needsCreation: missing, changed, binding: binding ?? null, source: join(project.path, passportInputs[0]), publisherEnabled: settings.passports.publisherEnabled === true };
    if (apply && (state.revision !== revision || !state.binding && binding)) {
      await atomicJson(statePath(home, project), { ...state, schemaVersion: 1, revision, observed: hashes, binding, pending, changed, queuedAt: iso() });
    }
    return result;
  };
  return apply ? withLock(join(home, 'passports', `${project.id}.lock`), run) : run();
}
export async function pendingPassports(home, projects, settings) {
  const result = [];
  for (const p of projects.filter(p => active(p, settings))) {
    try {
      const row = await refreshPassport(home, p, settings);
      if (row.mode === 'pending') result.push(row);
    } catch (error) { result.push({ project: p.name, id: p.id, mode: 'unavailable', error: safeError(error) }); }
  }
  return result;
}
export async function preparePassport(home, project, settings, { apply = false } = {}) {
  const row = await refreshPassport(home, project, settings, { apply });
  if (!apply || row.mode === 'disabled') return row;
  const markdown = await sourceText(project, passportInputs[0]);
  const fragment = renderMarkdown(markdown).replace(/<p><strong>(.*?)<\/strong><\/p>/gs, '<h2>$1</h2>');
  const html = join(home, 'passports', `${project.id}.fragment.html`);
  await writeFile(html, fragment, 'utf8');
  const state = await json(statePath(home, project), {});
  return { ...row, html, baseline: state.baseline ?? null };
}
// A publisher supplies read-back evidence after saving the same page.
export async function acknowledgePassport(home, project, settings, receipt, { apply = false } = {}) {
  if (!active(project, settings)) fail('PASSPORT_DISABLED', 'Automatic passports are disabled for this project.');
  validateBinding(receipt);
  if (!receipt.remoteContent?.trim() || !Array.isArray(receipt.remoteLinks) || !receipt.remoteLinks.every(x => typeof x === 'string') || !receipt.verifiedAt || !Number.isFinite(Date.parse(receipt.verifiedAt))) fail('PASSPORT_EVIDENCE', 'Reload the page and supply its visible content, link addresses and verification time.');
  const run = async () => {
    const hashes = await inputs(project), revision = digest(hashes);
    const state = await json(statePath(home, project), {});
    if (revision !== receipt.revision) fail('PASSPORT_CHANGED', 'Project documents changed during publication. Review again; no acknowledgement saved.');
    if (state.binding && (state.binding.pageUrl !== receipt.pageUrl || state.binding.boardId !== receipt.boardId)) fail('PASSPORT_REBIND', 'Existing passport binding preserved; review a destination change separately.');
    if (state.binding?.pageId && receipt.pageId !== state.binding.pageId) fail('PASSPORT_REBIND', 'Existing page ID preserved; review a destination change separately.');
    if (apply) await atomicJson(statePath(home, project), { ...state, schemaVersion: 1, observed: hashes, reviewedInputs: hashes, revision, reviewedRevision: revision, pending: false, changed: [], binding: { pageUrl: receipt.pageUrl, boardId: receipt.boardId, ...(receipt.pageId ? { pageId: receipt.pageId } : {}) }, baseline: { remoteContent: receipt.remoteContent, remoteLinks: receipt.remoteLinks, remoteHash: digest({ text: receipt.remoteContent, links: receipt.remoteLinks }), source: await sourceText(project, passportInputs[0]), verifiedAt: receipt.verifiedAt, remoteFormat: receipt.remoteFormat || 'visible-text', publishedVia: receipt.publishedVia || 'browser' } });
    return { project: project.name, mode: apply ? 'acknowledged' : 'acknowledge-preview', pageUrl: receipt.pageUrl, revision };
  };
  return apply ? withLock(join(home, 'passports', `${project.id}.lock`), run) : run();
}
