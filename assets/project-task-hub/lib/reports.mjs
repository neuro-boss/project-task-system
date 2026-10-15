import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { json, iso, fail, safeError } from './storage.mjs';
import { collectActivity, calendarDay, validDay, activitySnapshot } from './activity.mjs';

export function reportRange(period = 'day', anchor) {
  if (!validDay(anchor) || !['day', 'week', 'month'].includes(period)) fail('REPORT_PERIOD', 'Use day, week or month and a valid YYYY-MM-DD anchor.');
  const date = new Date(anchor + 'T00:00:00Z'), start = new Date(date), end = new Date(date);
  if (period === 'week') { start.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); end.setTime(start.getTime()); end.setUTCDate(start.getUTCDate() + 6); }
  if (period === 'month') { start.setUTCDate(1); end.setUTCMonth(date.getUTCMonth() + 1, 0); }
  return { period, from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
export function selectReport(data, { from, to, projectId }) {
  const projects = data.projects.filter(p => !projectId || p.id === projectId);
  const events = projects.flatMap(p => p.events.filter(e => e.day >= from && e.day <= to).map(e => ({ ...e, projectId: p.id, projectName: p.name })))
    .sort((a, b) => b.day.localeCompare(a.day) || a.projectName.localeCompare(b.projectName, 'ru'));
  const completed = new Set(events.filter(e => e.kind === 'completed').map(e => `${e.projectId}:${e.taskId}`)).size;
  return { projects, events, totals: { completed, observations: events.filter(e => e.origin === 'observation').length, notes: events.filter(e => e.origin === 'manual').length } };
}
async function atomicText(path, body) {
  const temporary = path + '.' + randomUUID() + '.tmp'; await writeFile(temporary, body, 'utf8'); await rename(temporary, path);
}
const kinds = { completed: 'Результат', created: 'Создано', updated: 'Изменено', started: 'Начато', reopened: 'Возобновлено', moved: 'Перемещено', progress: 'Продвижение', decision: 'Решение', blocker: 'Блокер', release: 'Выпуск', check: 'Проверка', research: 'Исследование' };
export function reportMarkdown(data) {
  const selected = selectReport(data, data.range);
  const lines = [`# Отчёт о работе: ${data.range.from} — ${data.range.to}`, '', `Часовой пояс: ${data.timeZone}. Данные собраны: ${data.createdAt}.`, '',
    `Задач с подтверждённым результатом: **${selected.totals.completed}**. Наблюдаемых изменений: **${selected.totals.observations}**. Отдельных заметок: **${selected.totals.notes}**.`, '',
    '> Исторические результаты восстановлены из WORK_LOG/Completed; время импорта не считается временем выполнения. Новые наблюдения датированы моментом обнаружения, а не точным временем работы. Оценки задач не считаются затраченными часами.', ''];
  for (const p of selected.projects) {
    lines.push(`## ${p.name}`, '');
    if (p.error) lines.push('**Источник сейчас недоступен; показан сохранённый журнал:** ' + p.error.message, '');
    const events = selected.events.filter(e => e.projectId === p.id);
    if (!events.length) lines.push('За выбранный период подтверждённых записей нет.', '');
    for (const e of events) {
      lines.push(`### ${e.day} · ${kinds[e.kind] || e.kind}${e.taskId ? ` · ${e.taskId}` : ''}`, '', e.summary || e.title || '', '');
      if (e.outcome) lines.push('**Проверка/итог:** ' + e.outcome, '');
      if (e.decisions) lines.push('**Решения:** ' + e.decisions, '');
      if (e.precision === 'observed') lines.push(`Обнаружено при проверке; предыдущая проверка: ${e.observedSince}.`, '');
      if (e.dateConflict) lines.push(`Расхождение дат: в Completed — ${e.dateConflict}, в WORK_LOG — ${e.day}; принят WORK_LOG.`, '');
      lines.push('Источник: ' + (e.sources || []).join(', ') + '.', '');
      if (e.sourcePath) lines.push(`[Открыть исходную запись](<${e.sourcePath.replace(/\\/g, '/')}>).`, '');
    }
    lines.push(`Покрытие: ${p.coverage?.historyResults || 0} исторических результатов; ${p.coverage?.doneWithoutDate || 0} завершённых задач без подтверждённой даты.`, '', `Проект: ${p.path}`, '');
    if (p.current?.length) lines.push('**В работе сейчас** (текущий снимок, не история периода):', '', ...p.current.map(t => `- ${t.id}: ${t.title}`), '');
  }
  return lines.join('\n');
}

export function reportHtml(data) {
  const serialized = JSON.stringify({ ...data, kinds }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Обзор работы · Project Task Hub</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#f4f6fa;color:#19243a}*{box-sizing:border-box}body{max-width:1120px;margin:auto;padding:36px 24px}header{display:flex;gap:20px;align-items:start;justify-content:space-between}h1{font-size:30px;letter-spacing:-1px;margin:6px 0}small,.muted{color:#5b687e}label{font-size:13px;display:grid;gap:6px}nav{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:26px 0}input,select,button{min-height:44px;font:inherit;border:1px solid #cbd3df;border-radius:9px;padding:10px;background:white;color:#19243a}button{cursor:pointer}input:focus-visible,select:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #2563eb;outline-offset:3px}article p{overflow-wrap:anywhere}button:hover{background:#e5edff}#stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.stat,section{background:white;border:1px solid #e1e6ee;border-radius:14px;padding:20px}.stat b{display:block;font-size:32px}section{margin:20px 0}h2{font-size:21px;margin:0 0 12px}article{padding:16px 0;border-top:1px solid #e6eaf0}article p{line-height:1.6;margin:8px 0;white-space:pre-wrap}summary{cursor:pointer;color:#365ba8}details{font-size:14px;margin-top:10px}footer{font-size:13px;line-height:1.6}.badge{font-size:12px;border-radius:6px;background:#eef2fa;padding:3px 7px;margin-left:8px}a{color:#365ba8}@media(max-width:640px){body{padding:20px 14px}header{display:block}#stats{gap:7px}.stat{padding:12px}.stat b{font-size:26px}nav>*{flex:1 1 140px}}@media(prefers-color-scheme:dark){:root{background:#111722;color:#e2e7f1}.stat,section,input,select,button{background:#1b2433;color:#e2e7f1;border-color:#344158}small,.muted{color:#a6b1c5}article{border-color:#344158}.badge{background:#344158}button:hover{background:#344158}a,summary{color:#9abbff}}</style>
<header><div><small>PROJECT TASK HUB / ЛИЧНЫЙ ЖУРНАЛ</small><h1>Обзор работы</h1><p class="muted">Результаты, изменения и решения по проектам</p></div><small id="asof"></small></header>
<nav><label>Проект<select id="project"><option value="">Все проекты</option></select></label><label>С<input id="from" type="date"></label><label>По<input id="to" type="date"></label><button data-period="day">День</button><button data-period="week">Неделя</button><button data-period="month">Месяц</button><label>Поиск<input id="search" type="search" placeholder="Задача, результат…"></label></nav>
<div id="stats" aria-live="polite"></div><p id="range" class="muted"></p><main id="projects"></main><footer>Это зафиксированная работа в зарегистрированных проектах. Исторические результаты взяты из WORK_LOG/Completed; наблюдения фиксируются при проверке. Переписка вне журнала не учитывается. Оценки задач не равны фактическим часам. Все данные находятся в этом локальном файле.</footer>
<script id="report-data" type="application/json">${serialized}</script><script>
const data=JSON.parse(document.getElementById('report-data').textContent), $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
$('from').value=data.range.from;$('to').value=data.range.to;$('asof').textContent='Данные: '+data.createdAt+' · '+data.timeZone;
for(const p of data.projects){const o=el('option',p.name);o.value=p.id;$('project').append(o)}
function render(){const from=$('from').value,to=$('to').value,query=$('search').value.toLocaleLowerCase();if(!from||!to||from>to){$('projects').replaceChildren();$('stats').replaceChildren();$('range').textContent='Укажите корректные даты: начало не позже конца.';return}$('projects').replaceChildren();let all=[];
for(const p of data.projects){if($('project').value&&$('project').value!==p.id)continue;const events=p.events.filter(e=>e.day>=from&&e.day<=to&&JSON.stringify([e.taskId,e.summary,e.title,e.outcome,e.decisions]).toLocaleLowerCase().includes(query)).sort((a,b)=>b.day.localeCompare(a.day));all.push(...events.map(e=>({...e,projectId:p.id})));const s=el('section');s.append(el('h2',p.name));
if(p.error)s.append(el('p','Источник сейчас недоступен; сохранённый журнал: '+p.error.message));else if(!events.length)s.append(el('p','За этот период подтверждённых записей нет.','muted'));
for(const e of events){const a=el('article');const meta=el('small',e.day+' · '+(e.taskId||'Заметка'));meta.append(el('span',data.kinds[e.kind]||e.kind,'badge'));a.append(meta,el('p',e.summary||e.title));if(e.outcome||e.decisions){const d=el('details');d.append(el('summary','Результат и подтверждения'));if(e.outcome)d.append(el('p',e.outcome));if(e.decisions)d.append(el('p','Решения: '+e.decisions));a.append(d)}a.append(el('small','Источник: '+(e.sources||[]).join(', ')+(e.precision==='observed'?' · время обнаружения, не точное время работы':'')));if(e.sourceUrl){const link=el('a','Открыть исходную запись');link.href=e.sourceUrl;a.append(el('br'),link)}if(e.dateConflict)a.append(el('p','Расхождение дат: Completed '+e.dateConflict+', WORK_LOG '+e.day,'muted'));s.append(a)}
if(p.current?.length){const d=el('details');d.append(el('summary','В работе сейчас: '+p.current.length+' (текущий снимок)'));for(const t of p.current)d.append(el('p',t.id+': '+t.title));s.append(d)}if(p.coverage)s.append(el('p','Исторических результатов: '+p.coverage.historyResults+' · Завершённых без даты: '+p.coverage.doneWithoutDate,'muted'));$('projects').append(s)}
const done=new Set(all.filter(e=>e.kind==='completed').map(e=>e.projectId+':'+e.taskId)).size;$('stats').replaceChildren();for(const [n,label]of [[done,'Задач с результатом'],[all.filter(e=>e.origin==='observation').length,'Наблюдаемых изменений'],[all.filter(e=>e.origin==='manual').length,'Заметок и решений']]){const s=el('div',undefined,'stat');s.append(el('b',String(n)),el('span',label));$('stats').append(s)}$('range').textContent=from+' — '+to+' · Неделя: понедельник–воскресенье, месяц: календарный';}
for(const id of ['project','from','to','search'])$(id).addEventListener('input',render);for(const b of document.querySelectorAll('[data-period]'))b.addEventListener('click',()=>{const r=data.ranges[b.dataset.period];$('from').value=r.from;$('to').value=r.to;render()});render();
</script></html>`;
}

export async function generateReport(home, projects, { period = 'day', date, from, to, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, out = join(home, 'reports'), now = iso(), archive = true } = {}) {
  const anchor = date || calendarDay(now, timeZone);
  const range = from || to ? { period: 'custom', from, to } : reportRange(period, anchor);
  if (!validDay(range.from) || !validDay(range.to) || range.from > range.to) fail('REPORT_DATES', 'Provide valid inclusive --from/--to dates.');
  const data = { schemaVersion: 1, createdAt: now, timeZone, range, ranges: Object.fromEntries(['day', 'week', 'month'].map(p => [p, reportRange(p, anchor)])), projects: [] };
  for (const project of projects) {
    try {
      await collectActivity(home, project, { apply: true, now, timeZone });
      const state = await json(join(home, `activity-${project.id}.json`));
      const snapshot = await activitySnapshot(project.path);
      const events = state.events.map(event => {
        if (!/^\.tasks\/[^/\\]+\.md$/.test(event.sourceFile || '')) return event;
        const sourcePath = join(project.path, event.sourceFile);
        return { ...event, sourcePath, sourceUrl: pathToFileURL(sourcePath).href };
      });
      data.projects.push({ id: project.id, name: project.name, path: project.path, events, coverage: state.coverage,
        current: snapshot.tasks.filter(t => t.state === 'In Progress').map(t => ({ id: t.id, title: t.title })) });
    } catch (error) {
      const cached = await json(join(home, `activity-${project.id}.json`), { events: [] }).catch(() => ({ events: [] }));
      data.projects.push({ id: project.id, name: project.name, path: project.path, events: cached.events, coverage: cached.coverage, error: safeError(error) });
    }
  }
  const folder = resolve(out); await mkdir(folder, { recursive: true });
  const scope = projects.length === 1 ? projects[0].id : 'all';
  const name = archive ? `report-${range.period}-${range.from}-${range.to}-${scope}-${now.replace(/[:.]/g, '-')}` : `latest-${scope}`;
  const paths = { markdown: join(folder, name + '.md'), html: join(folder, name + '.html'), json: join(folder, name + '.json'), latest: join(folder, `latest-${scope}.html`) };
  const html = reportHtml(data);
  await atomicText(paths.markdown, reportMarkdown(data)); await atomicText(paths.html, html); await atomicText(paths.json, JSON.stringify(data, null, 2)); if (paths.latest !== paths.html) await atomicText(paths.latest, html);
  if (scope === 'all') await atomicText(join(folder, 'index.html'), html);
  return { ...selectReport(data, range).totals, period: range, projects: projects.length, unavailable: data.projects.filter(p => p.error).length, paths };
}
