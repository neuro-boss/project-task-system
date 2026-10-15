// A small, deterministic renderer. Raw HTML is text; only generated tags reach YouGile.
export const descriptionVersion = 2;
export const escapeHtml = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export function inlineMarkdown(text) {
  const tokens = [];
  const token = html => `\u0000${tokens.push(html) - 1}\u0000`;
  let value = String(text).replace(/`([^`\n]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`));
  value = value.replace(/!?\[([^\]\n]+)\]\(([^\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return token(escapeHtml(label) + ' (' + escapeHtml(url) + ')');
    return token(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
  });
  value = escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,:;!?]|$)/g, '$1<em>$2</em>').replace(/~~(.+?)~~/g, '<s>$1</s>');
  value = value.replace(/https?:\/\/[^\s<\u0000]+/g, url => {
    const clean = url.replace(/[.,;!?]+$/, '');
    return `<a href="${clean}">${clean}</a>` + url.slice(clean.length);
  });
  return value.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

const listMatch = line => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const result = []; let i = 0;
  function list(indent) {
    const ordered = /^\d/.test(listMatch(lines[i])[2]); const tag = ordered ? 'ol' : 'ul'; const items = [];
    while (i < lines.length) {
      const match = listMatch(lines[i]);
      if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered) break;
      let body = inlineMarkdown(match[3].replace(/^\[([ xX])\]\s*/, (_, check) => check === ' ' ? '☐ ' : '☑ ')); i++;
      while (i < lines.length && lines[i].trim()) {
        const next = listMatch(lines[i]);
        if (next) { if (next[1].length > indent) body += list(next[1].length); else break; }
        else if (/^\s+/.test(lines[i]) && lines[i].match(/^\s*/)[0].length > indent) { body += '<br>' + inlineMarkdown(lines[i].trim()); i++; }
        else break;
      }
      items.push(`<li>${body}</li>`);
    }
    return `<${tag}>${items.join('')}</${tag}>`;
  }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
    }
    if (/^#{1,6}\s+/.test(line)) { result.push(`<p><strong>${inlineMarkdown(line.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, ''))}</strong></p>`); i++; continue; }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { result.push('<hr>'); i++; continue; }
    const match = listMatch(line);
    if (match) { result.push(list(match[1].length)); continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1])) {
      const head = tableCells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
      result.push(`<table><thead><tr>${head.map(s => `<th>${inlineMarkdown(s)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(s => `<td>${inlineMarkdown(s)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = []; while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      result.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !listMatch(lines[i]) && !/^\s*(?:#{1,6}\s|>|`{3,}|~{3,})/.test(lines[i])) paragraph.push(lines[i++]);
    result.push(`<p>${paragraph.map(s => inlineMarkdown(s.trimEnd())).join('<br>')}</p>`);
  }
  return result.join('');
}
