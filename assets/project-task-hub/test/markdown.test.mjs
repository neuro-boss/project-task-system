import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../lib/markdown.mjs';
import { matchesOwned } from '../lib/sync.mjs';
test('renders metadata, paragraphs, nested lists, headings, links, tables and code', () => {
  const html = renderMarkdown('**Priority:** P3\n**Estimate:** M\n\n### Что сделать\n- Первый пункт\n  - Вложенный\n- [x] Проверено\n\n[Открыть](https://example.com/a?b=1&c=2)\n\n| Поле | Значение |\n|---|---|\n| A | B |\n\n```js\nconst a = "<tag>";\n```');
  assert.match(html, /<strong>Priority:<\/strong> P3<br><strong>Estimate:/);
  assert.match(html, /<ul><li>Первый пункт<ul><li>Вложенный<\/li><\/ul><\/li><li>☑ Проверено/);
  assert.match(html, /href="https:\/\/example.com\/a\?b=1&amp;c=2"/);
  assert.match(html, /<table>/); assert.match(html, /<pre><code>const a = &quot;&lt;tag&gt;&quot;;/);
});
test('raw tags, unsafe links and literal examples cannot inject HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<order[id]> & value\n\n[open](javascript:alert) and `**literal**`');
  assert.doesNotMatch(html, /<script|href="javascript:/);
  assert.match(html, /&lt;order\[id\]&gt; &amp; value/);
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
});
test('YouGile normalized breaks and removed inline-code/quote wrappers do not cause repeated writes', () => {
  const expected = renderMarkdown('`example`\nline\n\n> A confirmed note');
  const remote = expected.replace(/<br>/g, '<br />').replace(/<\/?(?:code|blockquote)>/g, '');
  assert.equal(matchesOwned({ description: remote }, { description: expected }), true);
  assert.equal(matchesOwned({ description: remote + ' changed' }, { description: expected }), false);
});
