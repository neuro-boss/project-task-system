import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { json, atomicJson, withLock, digest, fail, safeError } from './storage.mjs';
import { pendingPassports } from './passport-sync.mjs';
import { resolveCodexBinary } from './codex-binary.mjs';

const execute = promisify(execFile);
const stateFile = home => join(home, 'passports', 'wake.json');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function queueCodex({ binary, threadId, message, cwd }, run = execute, resolveBinary = resolveCodexBinary) {
  // Argument array, hidden process, no shell interpolation and no permission overrides.
  await run(await resolveBinary(binary), ['queue', '--thread', threadId, '--message', message], { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
}
function prompt(root, id) {
  return `Обнаружена непустая очередь паспортов Project Task Hub. Идентификатор запроса: ${id}. Рабочая папка: ${JSON.stringify(root)}. Сначала выполни node cli.mjs passport --wake-start ${id} --apply в этой папке. Продолжай только если mode=started; при stale/busy закончи тихо. Прочитай PASSPORT-WORKER.md и .local/settings.json, затем passport --pending. Обработай только разрешённые enabled проекты через официальный MCP по этому протоколу, сохраняя UUID/URL страниц, ссылки и ручные дополнения. За этот запуск одна попытка на проект; при конфликте или недоступности сохрани pending. Не меняй расписания и не запускай повторный запрос агенту. В конце, в том числе при ошибке, выполни node cli.mjs passport --wake-finish ${id} --apply. Сообщай только о существенном обновлении, новой ошибке или необходимом решении; одинаковые ошибки не повторяй.`;
}
export async function wakePassports(home, projects, settings, { apply = false, dispatch = queueCodex, root, now = Date.now() } = {}) {
  const policy = settings.passports, wake = policy?.wake;
  if (!policy?.enabled || !policy.publisherEnabled || policy.publisher !== 'mcp' || !wake?.enabled) return { mode: 'disabled' };
  const run = async () => {
    const all = await pendingPassports(home, projects, settings);
    const pending = all.filter(p => p.mode === 'pending');
    const unavailable = all.filter(p => p.mode === 'unavailable').map(p => ({ id: p.id, error: p.error }));
    const previous = await json(stateFile(home), {});
    if (!pending.length) {
      if (apply && ['queued', 'running', 'submitting', 'uncertain'].includes(previous.status)) await atomicJson(stateFile(home), { ...previous, status: 'cleared', clearedAt: new Date(now).toISOString() });
      return { mode: unavailable.length ? 'unavailable' : 'empty', pending: 0, ...(unavailable.length ? { unavailable } : {}) };
    }
    if (!uuid(wake.threadId) || !wake.binary || !root) fail('PASSPORT_WAKE_CONFIG', 'Configure an existing Codex chat UUID, CLI binary and runtime directory.');
    const fingerprint = digest(pending.map(p => ({ id: p.id, revision: p.revision })).sort((a, b) => a.id.localeCompare(b.id)));
    const base = { pending: pending.length, fingerprint, ...(unavailable.length ? { unavailable } : {}) };
    if (['submitting', 'queued', 'uncertain'].includes(previous.status)) return { ...base, mode: previous.status === 'uncertain' ? 'uncertain' : 'queued-existing', id: previous.id };
    if (previous.status === 'running' && Date.parse(previous.leaseUntil) > now) return { ...base, mode: 'running', id: previous.id };
    if (!apply) return { ...base, mode: 'wake-preview', threadId: wake.threadId };
    const id = randomUUID();
    const intent = { id, status: 'submitting', fingerprint, projectIds: pending.map(p => p.id), threadId: wake.threadId, submittedAt: new Date(now).toISOString() };
    // Save before dispatch: a crash or unknown outcome must not enqueue the same work hourly.
    await atomicJson(stateFile(home), intent);
    return { ...base, id, intent };
  };
  const result = await (apply ? withLock(join(home, 'passports', 'wake.lock'), run) : run());
  if (!result.intent) return result;
  const { intent, ...base } = result;
  // Never hold the state lock while dispatching: the receiving worker can claim it immediately.
  try {
    await dispatch({ binary: wake.binary, threadId: wake.threadId, message: prompt(root, intent.id), cwd: root });
  } catch (error) {
    const knownNotSent = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) && !error.killed;
    await withLock(join(home, 'passports', 'wake.lock'), async () => {
      const latest = await json(stateFile(home));
      if (latest.id === intent.id && latest.status === 'submitting') await atomicJson(stateFile(home), { ...intent, status: knownNotSent ? 'not-sent' : 'uncertain', error: safeError(error) });
    });
    return { ...base, mode: knownNotSent ? 'not-sent' : 'uncertain', error: { code: 'PASSPORT_WAKE_DISPATCH', message: 'Codex wake could not be confirmed. Pending passports were preserved; inspect the local wake receipt before retrying an uncertain dispatch.' } };
  }
  await withLock(join(home, 'passports', 'wake.lock'), async () => {
    const latest = await json(stateFile(home));
    if (latest.id === intent.id && latest.status === 'submitting') await atomicJson(stateFile(home), { ...intent, status: 'queued' });
  });
  return { ...base, mode: 'queued', threadId: wake.threadId };
}
export async function transitionWake(home, id, action, { apply = false, now = Date.now() } = {}) {
  if (!uuid(id) || !['start', 'finish'].includes(action)) fail('PASSPORT_WAKE_ID', 'A wake request UUID and valid transition are required.');
  const run = async () => {
    const state = await json(stateFile(home), {});
    if (state.id !== id || ['finished', 'cleared', 'not-sent'].includes(state.status)) return { mode: 'stale', id };
    if (action === 'start' && state.status === 'running' && Date.parse(state.leaseUntil) > now) return { mode: 'busy', id };
    if (apply) await atomicJson(stateFile(home), { ...state, status: action === 'start' ? 'running' : 'finished', [action === 'start' ? 'startedAt' : 'finishedAt']: new Date(now).toISOString(), ...(action === 'start' ? { leaseUntil: new Date(now + 2 * 3_600_000).toISOString() } : {}) });
    return { mode: apply ? action === 'start' ? 'started' : 'finished' : `${action}-preview`, id };
  };
  return apply ? withLock(join(home, 'passports', 'wake.lock'), run) : run();
}
