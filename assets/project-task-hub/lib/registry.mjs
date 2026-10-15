import { readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { json, exists, digest, atomicJson, withLock, iso, fail } from './storage.mjs';

export const normal = path => process.platform === 'win32' ? path.toLowerCase() : path;
export async function canonical(path) { return realpath(resolve(path)); }
export async function repositoryIdentity(root) {
  let gitdir = join(root, '.git');
  try {
    const text = await readFile(gitdir, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
    if (match) gitdir = resolve(root, match[1].trim());
  } catch (e) { if (!['EISDIR', 'EPERM', 'EACCES', 'ENOENT'].includes(e.code)) throw e; }
  try { gitdir = resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim()); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  return normal(await realpath(gitdir).catch(() => root));
}
const excluded = /^(?:\.git|\.codex|\.agents|node_modules|\.venv|venv|vendor|dist|build|\.next|private|tmp|temp|\.local|.*backup.*|.*бекап.*|.*бэкап.*|.*recovery.*)$/i;
export async function discover(roots, maxDepth = 4) {
  const visited = new Set(); const found = [];
  async function visit(input, depth) {
    let root;
    try { root = await canonical(input); } catch { return; }
    if (visited.has(normal(root))) return;
    visited.add(normal(root));
    if (await exists(join(root, '.tasks/config.json'))) {
      let config = null; let configurationError = false;
      try { config = await json(join(root, '.tasks/yougile.local.json'), null); } catch { configurationError = true; }
      const gitIdentity = await repositoryIdentity(root);
      found.push({ id: digest(gitIdentity).slice(0, 20), name: basename(root), path: root, aliases: [resolve(input)], gitIdentity,
        workspaceKey: config?.workspaceKey || null, configured: !!config, configurationError });
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!excluded.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) await visit(join(root, entry.name), depth + 1);
    }
  }
  for (const root of roots) await visit(root, 0);
  return found;
}
export async function updateRegistry(home, fn) {
  return withLock(join(home, 'registry.lock'), async () => {
    const registry = await json(join(home, 'registry.json'), { schemaVersion: 1, projects: [] });
    const result = await fn(registry);
    registry.updatedAt = iso(); await atomicJson(join(home, 'registry.json'), registry); return result;
  }, { waitMs: 5000 });
}
export async function scan(home, roots, depth) {
  const found = await discover(roots, depth);
  await updateRegistry(home, registry => {
    for (const item of found) {
      const prior = registry.projects.find(x => x.id === item.id);
      if (prior) {
        // A worktree must not silently replace the selected sync source.
        prior.aliases = [...new Set([...prior.aliases, ...item.aliases, item.path])];
        if (normal(prior.path) === normal(item.path)) { prior.configured = item.configured; prior.workspaceKey = item.workspaceKey; prior.configurationError = item.configurationError; }
        prior.lastSeenAt = iso();
      } else registry.projects.push({ ...item, enabled: false, discoveredAt: iso(), lastSeenAt: iso() });
    }
  });
  return found;
}
export async function findProject(home, selector) {
  const { projects } = await json(join(home, 'registry.json'));
  const path = await canonical(selector).catch(() => null);
  const matches = projects.filter(p => p.id === selector || p.workspaceKey === selector || p.name === selector || (path && normal(p.path) === normal(path)));
  if (matches.length !== 1) fail('PROJECT_SELECTION', 'Select exactly one registered project by path or ID.');
  return matches[0];
}
