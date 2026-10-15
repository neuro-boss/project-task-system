import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { renderMarkdown, escapeHtml } from './markdown.mjs';
export async function exportPassport(home, project, { out = join(home, 'passports') } = {}) {
  const source = join(project.path, 'docs/project-passport.md');
  const markdown = await readFile(source, 'utf8');
  const folder = resolve(out); await mkdir(folder, { recursive: true });
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Паспорт · ${escapeHtml(project.name)}</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 22px;color:#19243a}a{color:#285bb8}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #d6dde8;padding:10px;text-align:left}pre{white-space:pre-wrap;background:#f1f4f8;padding:15px}p:has(>strong:only-child){font-size:21px;margin-top:28px}</style>${renderMarkdown(markdown)}</html>`;
  const path = join(folder, project.id + '.html'); await writeFile(path, html, 'utf8');
  return { project: project.name, source, html: path, knowledgeBasePublished: false, note: 'Local passport export. Knowledge-base page API is not configured; no duplicate board or task was created.' };
}
