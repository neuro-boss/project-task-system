import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fail } from './storage.mjs';
import { resolveCodexBinary } from './codex-binary.mjs';

// Codex handles OAuth/renewal in its existing secure store. This client never reads tokens.
export class CodexMcp {
  constructor({ binary = 'auto', server = 'yougile', cwd, timeoutMs = 60_000 } = {}) {
    this.binary = binary; this.server = server; this.cwd = cwd; this.timeoutMs = timeoutMs;
    this.requests = new Map(); this.sequence = 0;
  }
  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(Object.assign(new Error('MCP operation timed out; check the open YouGile tab. Mutations are not retried automatically.'), { code: 'MCP_TIMEOUT', safe: true })); }, this.timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.requests.delete(id); reject(Object.assign(new Error('MCP transport stopped.'), { code: 'MCP_TRANSPORT', safe: true })); }
      });
    });
  }
  async start({ knowledgeBase = true } = {}) {
    this.child = spawn(await resolveCodexBinary(this.binary), ['app-server'], { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => {
      for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Codex MCP transport could not start or stopped.'), { code: 'MCP_TRANSPORT', safe: true })); }
      this.requests.clear();
    };
    this.child.on('error', stop); this.child.on('exit', stop); this.child.stdin.on('error', stop);
    this.child.stderr.resume(); // Never log raw diagnostics, which can include remote content.
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      const pending = this.requests.get(value.id); if (!pending) return;
      clearTimeout(pending.timer); this.requests.delete(value.id);
      if (value.error) pending.reject(Object.assign(new Error('Codex rejected the MCP request; check the configured server, authentication and open YouGile tab.'), { code: 'MCP_REQUEST', safe: true }));
      else pending.resolve(value.result);
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'project_passport_mcp', version: '0.5.0' }, capabilities: { experimentalApi: true } });
      this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      if (!knowledgeBase) return this; // Metadata only: no thread, MCP calls or inference.
      // An in-memory transport context only: no turn/start, inference or saved sidebar chat.
      const context = await this.request('thread/start', { ephemeral: true, cwd: this.cwd });
      this.context = context.thread.id;
      const inventory = await this.request('mcpServerStatus/list', { threadId: this.context, detail: 'toolsAndAuthOnly', limit: 100 });
      const server = inventory.data.find(p => p.name === this.server);
      if (!server || !['kb_list_pages', 'kb_get_page', 'kb_write_page', 'get_project_tree', 'create_board'].every(k => server.tools[k])) fail('MCP_KB_TOOLS', 'Configured MCP server does not expose the required knowledge-base tools.');
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async call(tool, args) {
    if (!['kb_list_pages', 'kb_get_page', 'kb_write_page', 'get_project_tree', 'create_board'].includes(tool)) fail('MCP_SCOPE', 'Passport transport only permits knowledge-base operations.');
    if (tool === 'kb_write_page' && (args.deleted || args.parentId || args.afterId || args.first)) fail('MCP_SCOPE', 'Passport transport never deletes or moves pages.');
    if (tool === 'kb_write_page' && args.id && (args.title || args.boardId)) fail('MCP_SCOPE', 'Existing passport destinations and titles are preserved.');
    if (tool === 'create_board' && (args.type !== 'knowledgeBase' || args.columns?.length !== 0)) fail('MCP_SCOPE', 'Only a knowledge-base board with no task columns may be created.');
    const result = await this.request('mcpServer/tool/call', { threadId: this.context, server: this.server, tool, arguments: args });
    if (result.isError) fail('MCP_TOOL', 'YouGile rejected the knowledge-base operation; leave the passport pending.');
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n');
    try { return JSON.parse(text); } catch { fail('MCP_RESPONSE', 'YouGile returned an unsupported knowledge-base response.'); }
  }
  async close() {
    this.lines?.close();
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise(resolve => { const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1500); this.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}
