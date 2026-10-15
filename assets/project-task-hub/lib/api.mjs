import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJson, json, withLock, digest, sleep, fail } from './storage.mjs';

export class Api {
  constructor({ home, baseUrl, key, group, intervalMs = 1800, timeoutMs = 20_000, fetchFn = fetch }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('API_URL', 'An HTTPS API URL without credentials is required.');
    this.home = home; this.baseUrl = baseUrl.replace(/\/$/, ''); this.key = key;
    this.group = digest(group || url.origin).slice(0, 20); this.intervalMs = intervalMs; this.timeoutMs = timeoutMs; this.fetchFn = fetchFn;
  }
  static async fromConfig(home, root, config, settings = {}) {
    // Use the existing explicit file, not an ambient key that could belong to another company.
    const key = (await readFile(resolve(root, config.apiKeyFile || '.tasks/yougile.api-key.txt'), 'utf8')).trim();
    if (!key) fail('KEY_MISSING', 'Configured API key file is empty.');
    return new Api({ home, baseUrl: config.baseUrl, key, group: settings.rateGroup || new URL(config.baseUrl).origin,
      intervalMs: Math.max(1250, settings.minRequestIntervalMs || 1800), timeoutMs: config.timeoutMs || 20_000 });
  }
  async reserve(extraDelay = 0) {
    const ratePath = join(this.home, `rate-${this.group}.json`);
    await withLock(`${ratePath}.lock`, async () => {
      const rate = await json(ratePath, { nextAt: 0 });
      const at = Math.max(Date.now() + extraDelay, rate.nextAt);
      // Keep the reservation locked until issued, preventing cross-process reordering.
      if (at > Date.now()) await sleep(at - Date.now());
      await atomicJson(ratePath, { nextAt: Date.now() + this.intervalMs });
    }, { waitMs: 120_000 });
  }
  async request(method, path, body, { attempts = 4 } = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) fail('API_PATH', 'Invalid relative API path.');
    if (!['GET', 'POST', 'PUT'].includes(method)) fail('API_METHOD', 'This version does not delete remote objects.');
    const retryable = method === 'GET' || method === 'PUT' || (method === 'POST' && !!body?.idempotencyKey);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.reserve();
      let response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Accept: 'application/json', Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch {
        if (!retryable || attempt === attempts - 1) fail('NETWORK', 'YouGile is unavailable; changes remain pending for retry.');
        await sleep(Math.min(1000 * 2 ** attempt, 8000)); continue;
      }
      if (response.ok) {
        try { return await response.json(); } catch { fail('API_RESPONSE', 'YouGile returned an invalid JSON response.'); }
      }
      await response.body?.cancel().catch(() => {});
      if (retryable && (response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
        const header = response.headers.get('retry-after');
        const seconds = Number(header);
        const until = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : (seconds || 5) * 1000;
        const delay = Math.min(120_000, Math.max(1000, Number.isFinite(until) ? until : 5000));
        const ratePath = join(this.home, `rate-${this.group}.json`);
        await withLock(`${ratePath}.lock`, async () => {
          const rate = await json(ratePath, { nextAt: 0 });
          await atomicJson(ratePath, { nextAt: Math.max(rate.nextAt, Date.now() + delay) });
        }, { waitMs: 120_000 });
        continue;
      }
      fail(`HTTP_${response.status}`, `YouGile ${method} failed with HTTP ${response.status}; no sensitive response was logged.`);
    }
  }
  async list(resource, filters = {}) {
    const results = [];
    for (let offset = 0; ; ) {
      const params = new URLSearchParams({ ...filters, limit: '1000', offset: String(offset) });
      const page = await this.request('GET', `${resource}?${params}`);
      if (!Array.isArray(page.content)) fail('PAGINATION', 'YouGile returned an invalid list.');
      results.push(...page.content);
      const next = page.paging?.next;
      if (next === false || (next === undefined && page.content.length < 1000)) break;
      if (!page.content.length) fail('PAGINATION', 'YouGile pagination did not advance.');
      offset += page.content.length;
    }
    return results.filter(x => x.deleted !== true);
  }
}
