import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual command copied by Setup, without loading UI or reading real .env files.
const source = await readFile(new URL('../src/director-setup.ts', import.meta.url), 'utf8');
const command = source.match(/code\('([^']*\.env\.example[^']*)'\)/)?.[1].split('\\n')[0];
assert.ok(command, 'Setup must offer its first-use environment-copy command');
const run = cwd => spawnSync('/bin/sh', ['-c', command], { cwd, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });

test('Setup copies the template when configuration is absent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'video-setup-copy-'));
  await writeFile(join(cwd, '.env.example'), 'PREVIS_ALLOW_PAID=0\n');
  assert.equal(run(cwd).status, 0);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'PREVIS_ALLOW_PAID=0\n');
});

test('Setup repeated copy preserves existing private settings byte-for-byte', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'video-setup-existing-'));
  const saved = 'PREVIS_ALLOW_PAID=0\n# synthetic private configuration\nPORT=12345\n';
  await writeFile(join(cwd, '.env.example'), 'PORT=5190\n');
  await writeFile(join(cwd, '.env'), saved);
  assert.equal(run(cwd).status, 0);
  assert.equal(run(cwd).status, 0);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), saved);
});

test('Setup reports a missing template without creating an empty configuration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'video-setup-missing-'));
  assert.notEqual(run(cwd).status, 0);
  await assert.rejects(readFile(join(cwd, '.env')), { code: 'ENOENT' });
});
