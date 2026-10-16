import { spawn } from 'node:child_process';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, normal, scan, findProject, updateRegistry } from './registry.mjs';
import { json, withLock, iso, safeError } from './storage.mjs';
import { provision, adopt } from './provision.mjs';
import { recordSync } from './sync.mjs';
import { refreshPassport } from './passport-sync.mjs';

const hub = dirname(dirname(fileURLToPath(import.meta.url)));
export async function eligible(project, policy) {
  if (!policy?.enabled) return false;
  if (project.manuallyDisabled || policy.excludedProjectIds?.includes(project.id)) return false;
  let target;
  try { target = normal(await canonical(project.path)); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  for (const input of policy.roots || []) {
    let root;
    try { root = normal(await canonical(input)); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    const child = relative(root, target);
    if (child && !isAbsolute(child) && child !== '..' && !child.startsWith('..\\') && !child.startsWith('../')) return true;
  }
  return false;
}

async function runInstaller(home, project, policy, filename) {
  await new Promise((resolve, reject) => {
    const child = spawn(policy.python || 'python', [join(hub, filename), '--project', project.path, '--home', home, '--apply'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(Object.assign(new Error('Bridge installer could not start.'), { safe: true })));
    child.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error('Bridge installer requires review; original files preserved.'), { safe: true })));
  });
}
export const installBridge = (home, project, policy) => runInstaller(home, project, policy, 'install-bridge.py');
export const installActivityRules = (home, project, policy) => runInstaller(home, project, policy, 'install-activity.py');

// Dependencies can be replaced by offline fixtures; production always uses the verified connector.
export async function onboard(home, selector, settings, { apply = false, operations = {} } = {}) {
  const project = await findProject(home, selector);
  const policy = settings.autoOnboarding;
  if (!await eligible(project, policy)) return { project: project.name, action: 'outside-auto-policy' };
  if (project.enabled && !project.onboarding?.error) return { project: project.name, action: 'already-connected', passport: await (operations.passport || refreshPassport)(home, project, settings, { apply }) };
  if (!apply) return { project: project.name, action: project.configured ? 'adopt-existing-preview' : 'connect-new-preview', remoteWrites: 0, importHistory: false };
  try {
    return await withLock(join(home, `onboard-${project.id}.lock`), async () => {
      // Persist before the first network call so an interrupted setup is retried hourly.
      await updateRegistry(home, r => { r.projects.find(p => p.id === project.id).onboarding = { state: 'pending', attemptedAt: iso() }; });
      await (operations.activity || installActivityRules)(home, project, policy);
      if (!project.configured) await (operations.provision || provision)(home, project.path, policy.profileFrom, policy.assets, { apply: true });
      await (operations.bridge || installBridge)(home, project, policy);
      await (operations.adopt || adopt)(home, project.id, settings, { apply: true });
      await (operations.sync || recordSync)(home, await findProject(home, project.id), { apply: true, maxWrites: settings.maxWritesPerProject || 30 });
      await updateRegistry(home, r => { r.projects.find(p => p.id === project.id).onboarding = { state: 'connected', completedAt: iso() }; });
      const passport = await (operations.passport || refreshPassport)(home, await findProject(home, project.id), settings, { apply: true });
      return { project: project.name, action: 'connected', importHistory: false, passport };
    });
  } catch (error) {
    if (error.code === 'BUSY') return { project: project.name, action: 'busy' };
    const message = safeError(error);
    await updateRegistry(home, r => { r.projects.find(p => p.id === project.id).onboarding = { state: 'pending', attemptedAt: iso(), error: message }; });
    return { project: project.name, action: 'pending', error: message };
  }
}

export async function onboardDiscovered(home, settings, options = {}) {
  const registry = await json(join(home, 'registry.json'), { projects: [] });
  const results = [];
  for (const project of registry.projects) {
    if ((!project.enabled || project.onboarding?.error) && await eligible(project, settings.autoOnboarding)) {
      results.push(await onboard(home, project.id, settings, options));
    }
  }
  return results;
}

export async function registerAndOnboard(home, path, settings, options = {}) {
  let candidate;
  try { candidate = await findProject(home, path); }
  catch (error) { if (!['PROJECT_SELECTION', 'ENOENT'].includes(error.code)) throw error; candidate = { path, id: null }; }
  if (!await eligible(candidate, settings.autoOnboarding)) return { action: 'outside-auto-policy', remoteWrites: 0 };
  // Preview must not even register a candidate or contact YouGile.
  if (!options.apply) {
    return { action: 'onboard-preview', remoteWrites: 0 };
  }
  await scan(home, [path], 0);
  return onboard(home, path, settings, options);
}
