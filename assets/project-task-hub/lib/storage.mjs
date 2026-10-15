import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const iso = () => new Date().toISOString();
export async function json(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function exists(path) {
  try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const f = await open(tmp, 'wx', 0o600);
  try { await f.writeFile(`${JSON.stringify(value, null, 2)}\n`); await f.sync(); }
  finally { await f.close(); }
  try { await rename(tmp, path); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
export class BusyError extends Error { constructor() { super('Another hub operation is running'); this.code = 'BUSY'; } }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export async function lock(path, { waitMs = 0 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const start = Date.now();
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: iso() });
  while (true) {
    try {
      const f = await open(path, 'wx', 0o600);
      try { await f.writeFile(token); } finally { await f.close(); }
      return async () => { if (await readFile(path, 'utf8').catch(() => '') === token) await unlink(path).catch(() => {}); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const raw = await readFile(path, 'utf8').catch(() => null);
      let stale = false;
      try { const owner = JSON.parse(raw); stale = Number.isInteger(owner.pid) && !alive(owner.pid); }
      catch { const info = await stat(path).catch(() => null); stale = !!info && Date.now() - info.mtimeMs > 10_000; }
      if (stale && await readFile(path, 'utf8').catch(() => null) === raw) { await unlink(path).catch(() => {}); continue; }
      if (Date.now() - start >= waitMs) throw new BusyError();
      await sleep(50);
    }
  }
}
export async function withLock(path, fn, options) {
  const release = await lock(path, options);
  try { return await fn(); } finally { await release(); }
}
export function safeError(error) {
  // Unknown exception messages can contain headers, remote content or task text.
  if (error?.safe) return { code: error.code, message: error.message };
  return { code: error?.code || error?.name || 'ERROR', message: 'Operation failed; inspect configuration, connectivity and permissions. No sensitive response was logged.' };
}
export function fail(code, message) { const e = new Error(message); e.code = code; e.safe = true; throw e; }
