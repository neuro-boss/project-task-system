import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, json } from '../lib/storage.mjs';
import { collectActivity, addActivity, calendarDay, safeSummary } from '../lib/activity.mjs';
import { reportRange, generateReport, selectReport, reportHtml } from '../lib/reports.mjs';
const states = [['Backlog','BACKLOG.md'],['In Progress','IN_PROGRESS.md'],['Done','DONE.md']];
const section = (id, title, body='') => `## ${id}: ${title}\n**Priority:** P2\n${body}\n\n---\n`;
async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'hub-activity-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'project'),home=join(base,'hub');await mkdir(join(root,'.tasks'),{recursive:true});await mkdir(home);
  await atomicJson(join(root,'.tasks/config.json'),{states:states.map(([name,fileName])=>({name,fileName})),idPrefix:'TASK'});
  for(const [,f]of states)await writeFile(join(root,'.tasks',f),'# Tasks\n');
  const project={id:'example',path:root,name:'Example'};return{base,root,home,project};
}
const at = '2026-10-15T15:00:00Z';
test('imports WORK_LOG and Completed once with original dates; baseline is not work today',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.root,'.tasks/DONE.md'),section('TASK-001','Done task','**Completed:** 2026-10-12 10:00'));
  await writeFile(join(f.root,'.tasks/IN_PROGRESS.md'),section('TASK-002','Current task'));
  await writeFile(join(f.root,'.tasks/WORK_LOG.md'),'# Work Log\n\n## TASK-001 — 2026-10-12\n\n**What:** Useful result\n**Outcome:** Verified\n\n---\n');
  const before=await readFile(join(f.root,'.tasks/DONE.md'));
  const options={apply:true,now:at,timeZone:'Europe/Moscow'};
  assert.equal((await collectActivity(f.home,f.project,options)).added,1);
  assert.equal((await collectActivity(f.home,f.project,options)).added,0);
  const state=await json(join(f.home,'activity-example.json'));
  assert.equal(state.events.length,1);assert.equal(state.events[0].day,'2026-10-12');assert.equal(state.events[0].summary,'Useful result');assert.equal(state.events[0].outcome,'Verified');
  assert.deepEqual(new Set(state.events[0].sources),new Set(['Completed','WORK_LOG']));
  assert.deepEqual(await readFile(join(f.root,'.tasks/DONE.md')),before);
});
test('preview is read only and concurrent note retries are deduplicated',async t=>{
  const f=await fixture(t);await collectActivity(f.home,f.project,{now:at});
  await assert.rejects(readFile(join(f.home,'activity-example.json')),{code:'ENOENT'});
  const input={summary:'Investigated a blocker',kind:'research',taskId:'TASK-002'};
  await Promise.all([addActivity(f.home,f.project,input,{apply:true,now:at}),addActivity(f.home,f.project,input,{apply:true,now:at})]);
  assert.equal((await json(join(f.home,'activity-example.json'))).events.length,1);
});
test('records changes and reopening as observations, not as completed work',async t=>{
  const f=await fixture(t);const path=join(f.root,'.tasks/BACKLOG.md');await writeFile(path,section('TASK-001','First'));
  await collectActivity(f.home,f.project,{apply:true,now:at});
  await writeFile(path,section('TASK-001','Edited'));
  await collectActivity(f.home,f.project,{apply:true,now:'2026-10-16T10:00:00Z'});
  const event=(await json(join(f.home,'activity-example.json'))).events[0];assert.equal(event.kind,'updated');assert.equal(event.precision,'observed');assert.equal(event.observedSince,at);
});
test('completion observed before WORK_LOG is enriched rather than counted twice',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'.tasks/BACKLOG.md'),section('TASK-001','Task'));
  await collectActivity(f.home,f.project,{apply:true,now:at,timeZone:'UTC'});
  await writeFile(join(f.root,'.tasks/BACKLOG.md'),'# Backlog');await writeFile(join(f.root,'.tasks/DONE.md'),section('TASK-001','Task'));
  await collectActivity(f.home,f.project,{apply:true,now:'2026-10-15T16:00:00Z',timeZone:'UTC'});
  await writeFile(join(f.root,'.tasks/WORK_LOG.md'),'# Work Log\n\n## TASK-001 — 2026-10-15\n\n**What:** Finished\n\n---\n');
  await collectActivity(f.home,f.project,{apply:true,now:'2026-10-15T17:00:00Z',timeZone:'UTC'});
  const events=(await json(join(f.home,'activity-example.json'))).events;assert.equal(events.length,1);assert.equal(events[0].kind,'completed');assert.equal(events[0].summary,'Finished');
});
test('date conflicts do not create two completed tasks; missing dates remain explicit',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'.tasks/DONE.md'),section('TASK-001','Task','**Completed:** 2026-10-11')+section('TASK-002','Unknown date'));
  await writeFile(join(f.root,'.tasks/WORK_LOG.md'),'## TASK-001 — 2026-10-12\n\n**What:** Result\n');
  const result=await collectActivity(f.home,f.project,{apply:true,now:at});assert.equal(result.events,1);assert.equal(result.coverage.doneWithoutDate,1);
  const event=(await json(join(f.home,'activity-example.json'))).events[0];assert.equal(event.dateConflict,'2026-10-11');assert.equal(event.day,'2026-10-12');
});
test('periods use real calendar boundaries and time zones',()=>{
  assert.deepEqual(reportRange('week','2026-01-01'),{period:'week',from:'2025-12-29',to:'2026-01-04'});
  assert.deepEqual(reportRange('month','2024-02-18'),{period:'month',from:'2024-02-01',to:'2024-02-29'});
  assert.equal(calendarDay('2026-10-15T22:00:00Z','Europe/Moscow'),'2026-10-16');
  assert.throws(()=>reportRange('month','2026-02-30'));
});
test('same task IDs in different projects count separately, same result sources do not',()=>{
  const e={id:'1',kind:'completed',taskId:'TASK-001',day:'2026-10-15'};
  const data={projects:[{id:'a',name:'A',events:[e,{...e,id:'2'}]},{id:'b',name:'B',events:[e]}]};
  const options={from:'2026-10-01',to:'2026-10-31'};assert.equal(selectReport(data,options).totals.completed,2);assert.equal(selectReport(data,{...options,projectId:'a'}).totals.completed,1);
});
test('reports save Markdown/JSON and a self-contained searchable HTML view; partial coverage visible',async t=>{
  const f=await fixture(t);await addActivity(f.home,f.project,{summary:'Research complete',kind:'research'},{apply:true,now:at,timeZone:'UTC'});
  const result=await generateReport(f.home,[f.project,{id:'missing',name:'Missing',path:join(f.base,'missing')}],{period:'day',date:'2026-10-15',now:at,timeZone:'UTC'});
  assert.equal(result.notes,1);assert.equal(result.unavailable,1);
  assert.match(await readFile(result.paths.markdown,'utf8'),/Research complete/);
  const html=await readFile(result.paths.html,'utf8');assert.match(html,/Обзор работы/);assert.match(html,/type="date"/);assert.doesNotMatch(html,/<script src=/);
  assert.equal((await json(result.paths.json)).projects.length,2);
});
test('secrets and unsafe HTML do not leak into notes or executable report code',()=>{
  const safe=safeSummary('password=hunter2 OPENAI_API_KEY=abcdef Bearer qwerty alice@example.com https://host/private?token=123');
  for(const secret of ['hunter2','abcdef','qwerty','alice@example.com','token=123'])assert.equal(safe.includes(secret),false);
  const html=reportHtml({projects:[{id:'x',name:'<script>bad</script>',events:[]}],range:reportRange('day','2026-10-15'),ranges:{},createdAt:at,timeZone:'UTC'});
  assert.equal(html.includes('<script>bad</script>'),false);
});
test('hourly overview replaces latest files without accumulating hourly archives',async t=>{
  const f=await fixture(t);
  const first=await generateReport(f.home,[f.project],{now:at,timeZone:'UTC',archive:false});
  const second=await generateReport(f.home,[f.project],{now:'2026-10-15T16:00:00Z',timeZone:'UTC',archive:false});
  assert.equal(first.paths.html,second.paths.html);assert.equal(first.paths.json,second.paths.json);
  assert.equal((await json(second.paths.json)).createdAt,'2026-10-15T16:00:00Z');
});
test('unavailable project retains its previously recorded work in historical reports',async t=>{
  const f=await fixture(t);await addActivity(f.home,f.project,{summary:'Retained result',kind:'research'},{apply:true,now:at,timeZone:'UTC'});
  const result=await generateReport(f.home,[{...f.project,path:join(f.base,'offline')}],{now:at,date:'2026-10-15',timeZone:'UTC'});
  assert.equal(result.notes,1);assert.equal(result.unavailable,1);
  const text=await readFile(result.paths.markdown,'utf8');assert.match(text,/Retained result/);assert.match(text,/сохранённый журнал/);
});
