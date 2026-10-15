import { readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { atomicJson, json, digest, iso, fail, withLock } from './storage.mjs';

export function safeSummary(value) {
  return String(value || '').slice(0, 4000)
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-(?:proj-)?[\w-]{16,})\b/g, '[секрет скрыт]')
    .replace(/\b(?:Bearer\s+)[^\s]+/gi, 'Bearer [скрыто]')
    .replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*[^\s,;]+/gi, '$1=[скрыто]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email скрыт]')
    .replace(/https?:\/\/[^\s<>]+/g, '[ссылка в исходном проекте]');
}
export function calendarDay(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('DATE', 'Invalid event date.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const field = (body, name) => new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*?)(?=\\s*\\|\\s*\\*\\*|$)`, 'mi').exec(body)?.[1]?.trim() || null;
export async function activitySnapshot(root) {
  const config = await json(join(root, '.tasks/config.json'));
  if (!Array.isArray(config.states) || !config.states.length) fail('ACTIVITY_BOARD', 'Task states are missing.');
  const tasks = [], texts = {};
  for (const state of config.states) {
    const file = resolve(root, '.tasks', state.fileName), rel = relative(resolve(root, '.tasks'), file);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) fail('ACTIVITY_PATH', 'Task paths must stay inside .tasks.');
    const body = await readFile(file, 'utf8'); texts[state.fileName] = body;
    const pattern = new RegExp(`^## (${reEscape(config.idPrefix || 'TASK')}-\\d+):\\s*(.+?)\\r?\\n([\\s\\S]*?)(?=^---\\s*$)`, 'gm');
    for (const match of body.matchAll(pattern)) tasks.push({ id: match[1], title: safeSummary(match[2].trim()), state: state.name, sourceFile: '.tasks/' + state.fileName, hash: digest({ state: state.name, body: match[3], title: match[2] }),
      completed: field(match[3], 'Completed'), created: field(match[3], 'Created'), started: field(match[3], 'Started') });
  }
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) fail('ACTIVITY_MOVING', 'Tasks are being moved or have duplicate IDs; collection will retry.');
  const log = await readFile(join(root, '.tasks/WORK_LOG.md'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return { tasks, log, signature: digest({ config, texts, log }), config };
}
function historyResults(project, snapshot) {
  const results = new Map();
  const upsert = event => {
    const key = `${event.taskId}:${event.day}`;
    let previous = results.get(key);
    if (event.sources.includes('WORK_LOG')) {
      for (const [otherKey, other] of results) if (other.taskId === event.taskId && other.day !== event.day && other.sources.every(s => s === 'Completed')) {
        event.dateConflict = other.day; previous = other; results.delete(otherKey);
      }
    }
    results.set(key, { ...previous, ...event, sources: [...new Set([...(previous?.sources || []), ...event.sources])] });
  };
  for (const task of snapshot.tasks.filter(t => t.state === 'Done')) {
    const day = task.completed?.slice(0, 10);
    if (validDay(day)) upsert({ taskId: task.id, title: task.title, summary: task.title, day, sourceFile: task.sourceFile, precision: task.completed.length > 10 ? 'source-time' : 'source-day', sources: ['Completed'] });
  }
  const pattern = new RegExp(`^##\\s+(${reEscape(snapshot.config.idPrefix || 'TASK')}-\\d+)[^\\n]*?(\\d{4}-\\d{2}-\\d{2})[^\\n]*\\r?\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'gm');
  for (const match of snapshot.log.matchAll(pattern)) {
    if (!validDay(match[2])) continue;
    const task = snapshot.tasks.find(t => t.id === match[1]);
    upsert({ taskId: match[1], title: task?.title || safeSummary(field(match[3], 'What') || match[1]),
      summary: safeSummary(field(match[3], 'What') || task?.title || match[1]), outcome: safeSummary(field(match[3], 'Outcome')), decisions: safeSummary(field(match[3], 'Decisions')),
      day: match[2], sourceFile: '.tasks/WORK_LOG.md', precision: 'source-day', sources: ['WORK_LOG'] });
  }
  return [...results.values()].map(event => ({ ...event, id: digest(`${project.id}:result:${event.taskId}:${event.day}`), kind: 'completed', origin: 'history' }));
}

export async function collectActivity(home, project, { apply = false, now = iso(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  return withLock(join(home, `activity-${project.id}.lock`), async () => {
    const first = await activitySnapshot(project.path), second = await activitySnapshot(project.path);
    if (first.signature !== second.signature) fail('ACTIVITY_CHANGING', 'Project files changed during collection; retry.');
    const path = join(home, `activity-${project.id}.json`);
    const state = await json(path, { schemaVersion: 1, projectId: project.id, events: [], observations: {}, baselineAt: now });
    const byId = new Map(state.events.map(e => [e.id, e])), previouslyKnown = new Set(byId.keys()); let added = 0;
    const add = candidate => {
      if (candidate.kind === 'completed' && candidate.origin === 'history') {
        for (const [otherId, other] of byId) if (otherId !== candidate.id && other.kind === 'completed' && other.taskId === candidate.taskId && other.day === candidate.day && other.origin === 'observation') {
          candidate.observedAt = other.occurredAt; candidate.sources = [...new Set([...candidate.sources, ...other.sources])]; byId.delete(otherId);
        }
      }
      if (byId.has(candidate.id)) { const old = byId.get(candidate.id); old.sources = [...new Set([...(old.sources || []), ...(candidate.sources || [])])]; old.sourceFile ||= candidate.sourceFile; return; }
      byId.set(candidate.id, { ...candidate, recordedAt: now }); added++;
    };
    const history = historyResults(project, second); history.forEach(add);
    const day = calendarDay(now, timeZone);
    const observations = {};
    for (const task of second.tasks) {
      const before = state.observations[task.id];
      if (state.lastCollectedAt && (!before || before.hash !== task.hash)) {
        // A confirmed completion is represented by its source date, not today's import time.
        const importedCompletion = task.state === 'Done' && history.some(e => e.taskId === task.id && (!before || task.completed !== before.completed || !previouslyKnown.has(e.id)));
        if (!importedCompletion) {
          const kind = !before ? 'created' : before.state === 'Done' && task.state !== 'Done' ? 'reopened' : before.state !== task.state ? task.state === 'In Progress' ? 'started' : task.state === 'Done' ? 'completed' : 'moved' : 'updated';
          add({ id: digest(`${project.id}:change:${task.id}:${before?.hash}:${task.hash}:${state.lastCollectedAt}`), taskId: task.id, title: task.title, summary: task.title,
            kind, day, sourceFile: task.sourceFile, occurredAt: now, observedSince: state.lastCollectedAt, precision: 'observed', origin: 'observation', state: task.state, sources: ['.tasks observation'] });
        }
      }
      observations[task.id] = { hash: task.hash, state: task.state, completed: task.completed };
    }
    const coverage = { baselineAt: state.baselineAt, tasks: second.tasks.length,
      doneWithoutDate: second.tasks.filter(t => t.state === 'Done' && !validDay(t.completed?.slice(0, 10)) && !history.some(e => e.taskId === t.id)).length,
      historyResults: history.length, earliestKnownDay: history.map(e => e.day).sort()[0] || null };
    if (apply) await atomicJson(path, { ...state, events: [...byId.values()], observations, lastCollectedAt: now, coverage });
    return { project: project.name, added, events: byId.size, coverage, mode: apply ? 'collected' : 'preview' };
  }, { waitMs: 5000 });
}

export async function addActivity(home, project, input, { apply = false, now = iso(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const kinds = ['progress', 'decision', 'blocker', 'release', 'check', 'research'];
  if (!input.summary?.trim() || !kinds.includes(input.kind || 'progress')) fail('ACTIVITY_INPUT', 'A summary and a supported activity kind are required.');
  const day = input.day || calendarDay(now, timeZone);
  if (!validDay(day)) fail('DATE', 'Use YYYY-MM-DD for an activity date.');
  const event = { kind: input.kind || 'progress', taskId: input.taskId || null, summary: safeSummary(input.summary.trim()), outcome: safeSummary(input.outcome),
    day, occurredAt: input.day ? undefined : now, recordedAt: now, origin: 'manual', precision: input.day ? 'user-day' : 'recorded-time', sources: ['agent/user note'] };
  event.id = digest(`${project.id}:note:${input.id || `${event.taskId}:${event.kind}:${day}:${event.summary}`}`);
  if (!apply) return { project: project.name, mode: 'preview', event };
  return withLock(join(home, `activity-${project.id}.lock`), async () => {
    const path = join(home, `activity-${project.id}.json`), state = await json(path, { schemaVersion: 1, projectId: project.id, events: [], observations: {}, baselineAt: now });
    const exists = state.events.some(e => e.id === event.id);
    if (!exists) { state.events.push(event); await atomicJson(path, state); }
    return { project: project.name, mode: exists ? 'already-recorded' : 'recorded', eventId: event.id };
  }, { waitMs: 5000 });
}
