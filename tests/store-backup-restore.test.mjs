// docs/setup.md "Backup and restore a copy", end to end on tiny disposable stores: separately configured data,
// library and budget directories plus a private configuration file are written by the production stores, copied
// while no writer holds the project lock, restored into different directories and reopened by the same readers.
// Then a harmless edit to the restored copy is rolled back by restoring the pre-change backup again (same source
// version only; no cross-version migration or downgrade is claimed). Offline: the generation receipt and budget
// reservation are simulated records, nothing is dispatched, no provider or network is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseEnv } from 'node:util';
import { lockProject } from '../server/previs/lock.mjs';
import { openProject } from '../server/previs/store.mjs';
import { openDirector } from '../server/previs/director.mjs';
import { libraryDir } from '../server/previs/library.mjs';
import { openBudget, budgetDir } from '../server/previs/budget.mjs';
import { openGeneration } from '../server/previs/generation.mjs';
import { readZip } from '../server/previs/zip.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const sha = b => createHash('sha256').update(b).digest('hex');
const LAMP = 'b0000000-0000-4000-8000-000000000001';

/** Every regular file under dir as relative path → { size, sha256 }. */
async function tree(dir) {
  const out = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name), bytes = await readFile(file);
    out[relative(dir, file)] = { size: bytes.length, sha256: sha(bytes) };
  }
  return out;
}
const snapshot = async roots => Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([k, d]) => [k, await tree(d)])));
const copyStores = async (from, to) => { for (const k of Object.keys(from)) await cp(from[k], to[k], { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); };
const envOf = async file => ({ ...parseEnv(await readFile(file, 'utf8')) });
// The restored configuration keeps every value except the store paths, which select the restored directories.
const restoredConfig = (text, roots) => text.replace(/^PREVIS_DATA_DIR=.*$/m, `PREVIS_DATA_DIR=${roots.data}`).replace(/^PREVIS_LIBRARY_DIR=.*$/m, `PREVIS_LIBRARY_DIR=${roots.library}`).replace(/^PREVIS_BUDGET_DIR=.*$/m, `PREVIS_BUDGET_DIR=${roots.budget}`);

/** Open the stores the way server.mjs does, from a configuration file, under the project lock. */
async function openStores(configFile) {
  const env = await envOf(configFile), data = env.PREVIS_DATA_DIR;
  const release = await lockProject(data);
  const budget = await openBudget(budgetDir(data, env), { env });
  const project = await openProject(data);
  const generation = await openGeneration(data, project, { budget });
  const director = await openDirector(data, { libraryDir: libraryDir(data, env) });
  return { env, data, release, budget, project, generation, director };
}

test('a stopped full-store backup restores identity, edits, media, library, budget and job records; a same-version restore returns to the pre-change copy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'previs-backup-drill-'));
  try {
    // Separate data, library, budget and private configuration homes, as docs/setup.md step 1 records them.
    const original = { data: join(base, 'original/data'), library: join(base, 'original/library'), budget: join(base, 'original/budget'), config: join(base, 'original/config') };
    for (const d of Object.values(original)) await mkdir(d, { recursive: true });
    const configText = ['# Synthetic private configuration (no credentials)', `PREVIS_DATA_DIR=${original.data}`, `PREVIS_LIBRARY_DIR=${original.library}`,
      `PREVIS_BUDGET_DIR=${original.budget}`, 'PREVIS_ALLOW_PAID=0', 'PREVIS_BUDGET_MARGIN=0', 'PREVIS_BUDGET_PERIOD=all', ''].join('\n');
    await writeFile(join(original.config, 'previs.env'), configText, { mode: 0o600 });

    // Writer phase: production stores write a project with edits and media, a library asset, budget config and
    // a ledger reservation settled by a simulated completed generation receipt (never dispatched).
    let s = await openStores(join(original.config, 'previs.env'));
    assert.equal(libraryDir(s.data, s.env), original.library); assert.equal(budgetDir(s.data, s.env), original.budget);
    const created = await s.director.create({ template: 'empty', title: 'Backup drill' });
    await s.director.edit(created.id, [{ op: 'add_entity', entity: { id: LAMP, name: 'Desk lamp', shape: 'box', kind: 'prop', position: [1, 0, 2], notes: 'brass desk lamp' } }]);
    const { referenceId } = await s.director.reference(created.id, { scope: 'object', entityId: LAMP, name: 'Desk lamp look', data: PNG.toString('base64') });
    const saved = await s.director.library.save(created.id, { object: 'Desk lamp', tags: ['drill'] });
    await s.project.mutate(s.project.get().revision, q => { q.title = 'Engine drill'; });
    await s.budget.setCaps({ accountCapUsd: 0 });
    const jobId = randomUUID();
    await s.budget.reserve({ id: jobId, source: 'generation', projectId: created.id, estimateUsd: 0, label: 'Simulated job' });
    await writeFile(join(s.data, 'generation-jobs', `${jobId}.json`), JSON.stringify({ id: jobId, status: 'completed', simulated: true, createdAt: '2026-11-09T00:00:00.000Z', completedAt: '2026-11-09T00:00:01.000Z' }));
    await openGeneration(s.data, s.project, { budget: s.budget }); // production reader normalizes and follows it to the ledger
    const before = { project: await s.director.get(created.id), asset: await s.director.library.get(saved.asset.id), engine: s.project.get(), reservation: s.budget.get(jobId), status: s.budget.status(created.id) };
    const exportBefore = readZip((await s.director.exportZip(created.id)).data);
    assert.equal(before.reservation.state, 'settled');
    await s.release(); // stop the writer before copying
    await assert.rejects(stat(join(original.data, '.server-lock')), { code: 'ENOENT' });

    // Backup: copy every store and the configuration, then the stores are restored into different directories.
    const at = name => ({ data: join(base, name, 'data'), library: join(base, name, 'library'), budget: join(base, name, 'budget'), config: join(base, name, 'config') });
    const backup = at('backup'), restored = at('restored');
    const originalTree = await snapshot(original);
    await copyStores(original, backup);
    await copyStores(backup, restored);
    const restoredText = restoredConfig(configText, restored);
    await writeFile(join(restored.config, 'previs.env'), restoredText, { mode: 0o600 });
    // Byte coverage: every original file is in the backup with the same size and hash, nothing extra; the restored
    // copy matches too, except its configuration, which differs only in the three store paths.
    assert.deepEqual(await snapshot(backup), originalTree);
    const restoredTree = await snapshot(restored);
    assert.deepEqual({ ...restoredTree, config: {} }, { ...originalTree, config: {} });
    assert.deepEqual(await envOf(join(restored.config, 'previs.env')), { ...(await envOf(join(original.config, 'previs.env'))), PREVIS_DATA_DIR: restored.data, PREVIS_LIBRARY_DIR: restored.library, PREVIS_BUDGET_DIR: restored.budget });
    for (const store of ['data', 'library', 'budget']) assert.ok(Object.keys(originalTree[store]).length, `${store} store is not empty`);

    // Restore: the same production readers see the same identity, edits, media, library asset, budget and job.
    s = await openStores(join(restored.config, 'previs.env'));
    assert.equal(libraryDir(s.data, s.env), restored.library); assert.equal(budgetDir(s.data, s.env), restored.budget);
    const project = await s.director.get(created.id);
    assert.deepEqual(project, before.project);
    assert.ok(project.scene.entities.some(e => e.id === LAMP && e.look === referenceId));
    const ref = project.scene.references.find(r => r.id === referenceId);
    assert.equal(sha(await readFile(join(s.data, 'director', created.id, 'refs', ref.file))), sha(PNG));
    assert.deepEqual(await s.director.library.get(saved.asset.id), before.asset);
    assert.deepEqual(s.project.get(), before.engine);
    assert.deepEqual(s.budget.get(jobId), before.reservation); assert.deepEqual(s.budget.status(created.id), before.status);
    const job = s.generation.get(jobId); assert.equal(job.status, 'completed'); assert.equal(job.simulated, true);
    // A representative export from the restore carries the same files and hashes as one from the original.
    const exportAfter = readZip((await s.director.exportZip(created.id)).data);
    const listing = zip => JSON.parse(zip.get('previs-export.json')).files;
    assert.deepEqual(listing(exportAfter), listing(exportBefore));

    // Harmless change on the restored copy, then return: restore the pre-change backup again (same version).
    await s.director.edit(created.id, [{ op: 'set_project', patch: { title: 'Changed after restore' } }]);
    await s.release();
    const rollback = at('rollback');
    await copyStores(backup, rollback);
    await writeFile(join(rollback.config, 'previs.env'), restoredConfig(configText, rollback), { mode: 0o600 });
    assert.deepEqual({ ...(await snapshot(rollback)), config: {} }, { ...originalTree, config: {} });
    s = await openStores(join(rollback.config, 'previs.env'));
    assert.deepEqual(await s.director.get(created.id), before.project);
    await s.release();

    // The original stores and the backup were never written by any restore.
    assert.deepEqual(await snapshot(original), originalTree);
    assert.deepEqual(await snapshot(backup), originalTree);
  } finally { await rm(base, { recursive: true, force: true }); }
});
