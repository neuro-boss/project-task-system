import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { json, atomicJson, iso, safeError, fail, withLock } from './lib/storage.mjs';
import { scan, findProject, updateRegistry } from './lib/registry.mjs';
import { adopt, provision } from './lib/provision.mjs';
import { recordSync } from './lib/sync.mjs';
import { registerAndOnboard, onboardDiscovered } from './lib/onboarding.mjs';
import { collectActivity, addActivity } from './lib/activity.mjs';
import { generateReport } from './lib/reports.mjs';
import { exportPassport } from './lib/passport.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const n = args.indexOf(name); return n < 0 ? undefined : args[n + 1]; };
const home = resolve(option('--home') || process.env.PROJECT_TASK_HUB_HOME || join(root, '.local'));
const output = value => console.log(JSON.stringify(value, null, 2));
const settingsPath = join(home, 'settings.json');
async function tick(settings) {
  return withLock(join(home, 'tick.lock'), async () => {
    const previous = await json(join(home, 'heartbeat.json'), {});
    const shouldScan = !previous.lastScanAt || Date.now() - Date.parse(previous.lastScanAt) >= (settings.discoveryIntervalMs || 3_600_000);
    if (shouldScan) await scan(home, settings.roots, settings.scanDepth || 4);
    const onboarding = await onboardDiscovered(home, settings, { apply: true });
    const registry = await json(join(home, 'registry.json'));
    const activity = [];
    for (const project of registry.projects.filter(p => !p.enabled)) {
      try { activity.push(await collectActivity(home, project, { apply: true, timeZone: settings.reportTimeZone })); }
      catch (error) { activity.push({ project: project.name, error: safeError(error) }); }
    }
    const results = [];
    for (const project of registry.projects.filter(p => p.enabled)) {
      const status = await json(join(home, `status-${project.id}.json`), {});
      if (status.nextAttemptAt && Date.parse(status.nextAttemptAt) > Date.now()) { results.push({ project: project.name, mode: 'backoff' }); continue; }
      try { results.push(await recordSync(home, project, { apply: true, maxWrites: settings.maxWritesPerProject || 40 })); }
      catch (e) { results.push({ project: project.name, error: safeError(e) }); }
    }
    let report;
    try { report = await generateReport(home, registry.projects, { period: 'day', timeZone: settings.reportTimeZone, archive: false }); }
    catch (error) { report = { error: safeError(error) }; }
    const heartbeat = { at: iso(), lastScanAt: shouldScan ? iso() : previous.lastScanAt, onboarding, activity, report, results };
    await atomicJson(join(home, 'heartbeat.json'), heartbeat);
    if ([...results, ...onboarding, report].some(r => r.error)) process.exitCode = 1;
    return heartbeat;
  });
}
async function main() {
  const command = args[0] || 'status';
  if (command === 'help' || flag('--help')) return output({ commands: ['scan', 'status', 'onboard --project PATH [--apply]', 'adopt --project PATH [--apply]', 'connect --project PATH --profile-from PATH --assets PATH [--apply]', 'sync --project PATH [--task ID] [--apply] [--reconcile]', 'tick --apply', 'collect [--project PATH|all] [--apply]', 'log --project PATH --summary TEXT [--kind research|decision|progress|blocker|release|check] [--apply]', 'report [--project PATH|all] [--period day|week|month] [--date YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]', 'passport --project PATH', 'disable --project PATH --apply'], home });
  const settings = await json(settingsPath, { roots: [], minRequestIntervalMs: 1800, scanDepth: 4 });
  if (command === 'passport') return output(await exportPassport(home, await findProject(home, option('--project')), { out: option('--out') }));
  if (command === 'collect' || command === 'report') {
    const selector = option('--project');
    const projects = selector && selector !== 'all' ? [await findProject(home, selector)] : (await json(join(home, 'registry.json'))).projects;
    const timeZone = option('--timezone') || settings.reportTimeZone;
    if (command === 'report') return output(await generateReport(home, projects, { period: option('--period') || 'day', date: option('--date'), from: option('--from'), to: option('--to'), timeZone, out: option('--out') }));
    const results = [];
    for (const project of projects) {
      try { results.push(await collectActivity(home, project, { apply: flag('--apply'), timeZone })); }
      catch (error) { results.push({ project: project.name, error: safeError(error) }); process.exitCode = 1; }
    }
    return output(results);
  }
  if (command === 'log') {
    if (!option('--project')) fail('ARGUMENTS', 'log requires --project PATH.');
    const project = await findProject(home, option('--project'));
    const input = option('--file') ? await json(resolve(option('--file'))) : { summary: option('--summary'), outcome: option('--outcome'), taskId: option('--task'), kind: option('--kind'), day: option('--date'), id: option('--id') };
    return output(await addActivity(home, project, input, { apply: flag('--apply'), timeZone: option('--timezone') || settings.reportTimeZone }));
  }
  if (command === 'onboard') {
    if (!option('--project')) fail('ARGUMENTS', 'onboard requires --project PATH.');
    const result = await registerAndOnboard(home, option('--project'), settings, { apply: flag('--apply') });
    if (result.error) process.exitCode = 1;
    return output(result);
  }
  if (command === 'scan') return output(await scan(home, option('--root') ? [option('--root')] : settings.roots, settings.scanDepth));
  if (command === 'status') {
    const registry = await json(join(home, 'registry.json'), { projects: [] });
    const rows = [];
    for (const p of registry.projects) rows.push({ id: p.id, name: p.name, path: p.path, enabled: p.enabled, configured: p.configured, workspaceKey: p.workspaceKey, onboarding: p.onboarding, manuallyDisabled: p.manuallyDisabled,
      ...await json(join(home, `status-${p.id}.json`), {}) });
    return output({ projects: rows, heartbeat: await json(join(home, 'heartbeat.json'), null) });
  }
  if (command === 'connect') {
    if (!option('--project') || !option('--profile-from') || !option('--assets')) fail('ARGUMENTS', 'connect requires --project, --profile-from and --assets.');
    return output(await provision(home, option('--project'), option('--profile-from'), option('--assets'), { apply: flag('--apply') }));
  }
  if (command === 'adopt') return output(await adopt(home, option('--project'), settings, { apply: flag('--apply') }));
  if (command === 'disable') {
    if (!flag('--apply')) return output({ action: 'disable-preview', project: option('--project') });
    const project = await findProject(home, option('--project'));
    await updateRegistry(home, r => { const entry = r.projects.find(p => p.id === project.id); entry.enabled = false; entry.manuallyDisabled = true; });
    return output({ action: 'disabled', project: project.name });
  }
  if (command === 'sync' || command === 'audit') {
    if (flag('--import-history')) fail('HISTORY_DISABLED', 'History import is a separate reviewed action; the background hub does not import history.');
    const projects = option('--project') ? [await findProject(home, option('--project'))] : (await json(join(home, 'registry.json'))).projects.filter(p => p.enabled);
    const results = [];
    for (const project of projects) {
      try { results.push(await recordSync(home, project, { apply: command === 'audit' || flag('--apply'), taskId: option('--task'), reconcile: command === 'audit' || flag('--reconcile'), maxWrites: command === 'audit' ? 0 : (settings.maxWritesPerProject || 40) })); }
      catch (e) { results.push({ project: project.name, error: safeError(e) }); process.exitCode = 1; }
    }
    return output(results);
  }
  if (command === 'tick') {
    if (!flag('--apply')) fail('APPLY_REQUIRED', 'tick requires --apply. Use sync for an offline preview.');
    try { return output(await tick(settings)); } catch (e) { if (e.code === 'BUSY') return output({ mode: 'busy' }); throw e; }
  }
  fail('COMMAND', 'Unknown command. Run node cli.mjs help.');
}
main().catch(e => { output({ error: safeError(e) }); process.exitCode = 1; });
