import { stat, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

// Resolve on every launch: desktop upgrades replace the directory named by a build hash.
export async function resolveCodexBinary(configured = 'auto', { env = process.env, platform = process.platform } = {}) {
  const executable = async path => {
    if (!path || /\.(?:cmd|bat|ps1)$/i.test(path)) return false;
    try { return (await stat(path)).isFile() && (platform === 'win32' || await access(path, constants.X_OK).then(() => true)); }
    catch { return false; }
  };
  if (configured && configured !== 'auto' && isAbsolute(configured) && await executable(configured)) return configured;
  if (await executable(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const base = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'), candidates = [];
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(base, entry.name, 'codex.exe');
      if (await executable(path)) candidates.push({ path, time: (await stat(path)).mtimeMs });
    }
    candidates.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
    if (candidates.length) return candidates[0].path;
  }
  const name = configured && configured !== 'auto' && !isAbsolute(configured) ? configured : platform === 'win32' ? 'codex.exe' : 'codex';
  if (!/[\\/]/.test(name)) for (const directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const path = resolve(directory, name);
    if (await executable(path)) return path;
  }
  throw Object.assign(new Error('Codex executable is unavailable. Pending work is preserved; install or launch the current desktop app.'), { code: 'ENOENT', safe: true });
}
