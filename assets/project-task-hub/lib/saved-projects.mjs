import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexMcp } from './codex-mcp.mjs';
import { canonical, normal, repositoryIdentity, scan } from './registry.mjs';
import { eligible } from './onboarding.mjs';
import { json, atomicJson, exists, withLock, digest, iso, safeError, fail } from './storage.mjs';

const runtime = dirname(dirname(fileURLToPath(import.meta.url)));
const beneath = (parent, child) => { const r = relative(normal(parent), normal(child)); return !!r && !isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\'); };
const excluded = /^(?:\.git|\.codex|\.agents|node_modules|\.venv|venv|vendor|dist|build|\.next|private|tmp|temp|\.local|outputs?|_montage_work|.*backup.*|.*бекап.*|.*бэкап.*|.*recovery.*)$/i;
export function discoveryDue(lastScanAt, now = Date.now(), interval = 3_600_000) {
  const previous = Date.parse(lastScanAt);
  // A slow previous tick or scheduler jitter must not turn hourly discovery into every two hours.
  return !Number.isFinite(previous) || Math.floor(now / interval) > Math.floor(previous / interval);
}

export async function listSavedProjects(settings) {
  const client = await new CodexMcp({ binary: settings.autoOnboarding?.savedProjects?.binary || 'auto', cwd: runtime }).start({ knowledgeBase: false });
  try {
    const projects = []; let cursor;
    do {
      const page = await client.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) fail('SAVED_PROJECTS_RESPONSE', 'Codex project inventory is unavailable.');
      projects.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    return projects;
  } finally { await client.close(); }
}

// Add only missing project-system files. Existing content and task boards belong to the project.
export async function initializeProject(home, path, { templateRoot } = {}) {
  const root = await canonical(path), key = digest(normal(root)).slice(0, 20);
  return withLock(join(home, `initialize-${key}.lock`), async () => {
    if (await exists(join(root, '.tasks/config.json'))) return { mode: 'existing-board' };
    templateRoot ||= await exists(join(runtime, 'project-template')) ? join(runtime, 'project-template') : join(runtime, '..', 'project-template');
    const intent = join(home, 'initializations', `${key}.json`);
    if ((await readdir(join(root, '.tasks')).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).length && !await exists(intent)) fail('SAVED_PROJECT_PARTIAL', 'Existing .tasks without config was preserved for manual review.');
    await atomicJson(intent, { path: root, at: iso(), state: 'initializing' });
    const created = [], updated = [];
    const text = async name => (await readFile(join(templateRoot, name), 'utf8')).replaceAll('%PROJECT_NAME%', basename(root)).replaceAll('%TASKPLANNER_VERSION%', '2.3.0');
    async function create(name, content) {
      let current = root;
      for (const part of name.split('/')) {
        current = join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) fail('SAVED_PROJECT_SYMLINK', 'Project-system destinations must not be symbolic links.'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      await mkdir(dirname(join(root, name)), { recursive: true });
      try { await writeFile(join(root, name), content, { flag: 'wx' }); created.push(name); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    for (const name of await readdir(join(templateRoot, 'tasks'))) if (name !== 'config.json') await create(`.tasks/${name}`, await text(`tasks/${name}`));
    for (const name of await readdir(join(templateRoot, 'docs'))) await create(`docs/${name}`, await text(`docs/${name}`));
    for (const [source, name] of [['AGENTS.md', 'AGENTS.md'], ['CLAUDE.md', 'CLAUDE.md'], ['cursorrules', '.cursorrules']]) {
      const template = await text(source), destination = join(root, name);
      await create(name, template);
      const original = await readFile(destination, 'utf8'); let next = original;
      for (const marker of ['PROJECT-SYSTEM', 'TASKPLANNER']) {
        if (next.includes(`<!-- ${marker}:START -->`)) continue;
        const block = template.match(new RegExp(`<!-- ${marker}:START -->[\\s\\S]*?<!-- ${marker}:END -->`))?.[0];
        if (!block) fail('SAVED_PROJECT_TEMPLATE', 'Project instruction template is incomplete.');
        next += `\n\n${block}\n`;
      }
      if (next !== original) {
        await mkdir(join(home, 'initializations', key), { recursive: true });
        try { await writeFile(join(home, 'initializations', key, name), await readFile(destination), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        await writeFile(destination, next); updated.push(name);
      }
    }
    await create('.tasks/config.json', await text('tasks/config.json')); // Commit marker after state files exist.
    await atomicJson(intent, { path: root, at: iso(), state: 'initialized', created, updated });
    return { mode: 'initialized', created, updated };
  });
}

// First run takes a baseline: existing saved projects are not mass-connected on upgrade.
// Pending paths are durable before initialization and retried on the next hourly scan.
export async function discoverSavedProjects(home, settings, { apply = false, list = listSavedProjects, initialize = initializeProject } = {}) {
  if (!settings.autoOnboarding?.enabled || !settings.autoOnboarding.savedProjects?.enabled) return { mode: 'disabled' };
  const run = async () => {
    const file = join(home, 'saved-projects.json'), state = await json(file, null);
    let saved;
    try { saved = await list(settings); }
    catch (error) { return { mode: 'unavailable', error: safeError(error) }; }
    const inventory = [];
    for (const p of saved) for (const entry of p.roots || []) {
      try { inventory.push({ path: await canonical(entry.path), savedId: p.id }); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    const next = state || { schemaVersion: 1, baselineAt: iso(), known: [], pending: [] };
    const known = new Set(next.known), registry = await json(join(home, 'registry.json'), { projects: [] });
    const approvedRoots = [];
    for (const root of settings.autoOnboarding.roots || []) { try { approvedRoots.push(await canonical(root)); } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; } }
    for (const item of inventory) {
      const key = digest(normal(item.path));
      if (known.has(key)) continue;
      known.add(key);
      if (!state || !await eligible({ ...item, id: digest(await repositoryIdentity(item.path)).slice(0, 20) }, settings.autoOnboarding)) continue;
      const parents = [...inventory, ...registry.projects];
      if (parents.some(p => beneath(p.path, item.path))) continue;
      const identity = digest(await repositoryIdentity(item.path)).slice(0, 20);
      if (registry.projects.some(p => p.id === identity && normal(p.path) !== normal(item.path))) continue;
      const root = approvedRoots.map(p => normal(p)).find(p => beneath(p, item.path));
      if (!root || relative(root, normal(item.path)).split(/[\\/]/).some(p => excluded.test(p))) continue;
      const prior = registry.projects.find(p => normal(p.path) === normal(item.path));
      if (prior?.manuallyDisabled || settings.autoOnboarding.excludedProjectIds?.includes(prior?.id)) continue;
      next.pending.push(item);
    }
    next.known = [...known];
    if (!apply) return { mode: state ? 'discovery-preview' : 'baseline-preview', pending: next.pending.map(p => p.path), remoteWrites: 0 };
    await atomicJson(file, next);
    const results = [];
    for (const item of [...next.pending]) {
      try {
        const id = digest(await repositoryIdentity(item.path)).slice(0, 20);
        const prior = registry.projects.find(p => p.id === id);
        if (!await eligible({ ...item, id, manuallyDisabled: prior?.manuallyDisabled }, settings.autoOnboarding)) { results.push({ path: item.path, mode: 'outside-auto-policy' }); continue; }
        const result = await initialize(home, item.path);
        await scan(home, [item.path], 0);
        next.pending = next.pending.filter(p => normal(p.path) !== normal(item.path));
        results.push({ path: item.path, ...result });
      } catch (error) { results.push({ path: item.path, error: safeError(error) }); }
      await atomicJson(file, next);
    }
    return { mode: state ? 'discovered' : 'baseline-saved', known: next.known.length, pending: next.pending.length, results };
  };
  return apply ? withLock(join(home, 'saved-projects.lock'), run) : run();
}
