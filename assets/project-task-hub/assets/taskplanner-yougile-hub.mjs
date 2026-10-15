// Optional local routing layer. Without the ignored pointer file the original connector works normally.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export async function routeToHub(moduleUrl) {
  const args = process.argv.slice(2);
  if (!args.includes('--apply')) return;
  const option = name => { const n = args.indexOf(name); return n < 0 ? undefined : args[n + 1]; };
  const root = resolve(option('--workspace') || resolve(dirname(fileURLToPath(moduleUrl)), '..'));
  let pointer;
  try { pointer = JSON.parse(await readFile(resolve(root, '.tasks/yougile.hub.local.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw new Error('Invalid local hub pointer; synchronization stopped.'); }
  if (!pointer.enabled) return;
  if (option('--config') || args.includes('--import-history')) throw new Error('Custom config/history import requires a separately reviewed workflow. Hub synchronization stopped.');
  const forwarded = [pointer.cli, 'sync', '--home', pointer.home, '--project', root, '--apply'];
  if (option('--task')) forwarded.push('--task', option('--task'));
  const child = spawnSync(process.execPath, forwarded, { stdio: 'inherit', windowsHide: true });
  process.exit(child.status ?? 1);
}
