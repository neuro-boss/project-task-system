// Local reporting and journal commands, including projects without YouGile.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
if (!['log', 'report', 'collect', 'passport'].includes(command) || args.includes('--home') || args.includes('--project')) throw new Error('Use log, report, collect or passport for this project.');
const pointer = JSON.parse(await readFile(resolve(root, '.tasks/project-task-hub.local.json'), 'utf8'));
const child = spawnSync(process.execPath, [pointer.cli, command, '--home', pointer.home, '--project', root, ...args], { stdio: 'inherit', windowsHide: true });
process.exit(child.status ?? 1);
