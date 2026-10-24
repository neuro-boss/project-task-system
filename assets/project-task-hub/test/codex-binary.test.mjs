import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexBinary } from '../lib/codex-binary.mjs';

test('stale configured and environment paths fall back to the installed app after upgrades', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-resolve-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'OpenAI/Codex/bin');
  const install = async hash => { const path = join(base, hash, 'codex.exe'); await mkdir(join(base, hash), { recursive: true }); await writeFile(path, 'fixture'); return path; };
  const first = await install('old');
  const env = { LOCALAPPDATA: root, CODEX_CLI_PATH: join(root, 'missing.exe') };
  assert.equal(await resolveCodexBinary(join(root, 'gone.exe'), { env, platform: 'win32' }), first);
  await rm(first); const next = await install('new');
  assert.equal(await resolveCodexBinary('auto', { env, platform: 'win32' }), next);
  env.CODEX_CLI_PATH = process.execPath;
  assert.equal(await resolveCodexBinary('auto', { env, platform: 'win32' }), process.execPath);
});
test('PATH lookup uses executable files, refuses shell wrappers and reports known not-sent errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-path-')); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex.exe'); await writeFile(executable, 'fixture');
  assert.equal(await resolveCodexBinary('auto', { env: { PATH: root }, platform: 'win32' }), executable);
  await assert.rejects(resolveCodexBinary('codex.cmd', { env: { PATH: root }, platform: 'win32' }), { code: 'ENOENT', safe: true });
  await assert.rejects(resolveCodexBinary('auto', { env: {}, platform: 'win32' }), { code: 'ENOENT' });
});
