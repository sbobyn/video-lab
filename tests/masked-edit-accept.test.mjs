// Masked-edit acceptance against a real director store: the take is appended to the CURRENT project on the
// director write queue, so edits made while the composite encodes are kept. Offline — injected encoder, no
// ffmpeg, no generation, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDirector, createProjectDocument } from '../server/previs/director.mjs';
import { openMaskedEdit } from '../server/previs/masked-edit.mjs';
import { sha, videoAsset } from './fixtures/masked-edit/helpers.mjs';

const FRAMES = 81;

async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'previs-me-accept-'));
  const p = createProjectDocument({ title: 'Accept' }, randomUUID(), []);
  const shotId = p.shots[0].id;
  const parentBytes = Buffer.from('parent-take');
  const parent = videoAsset(randomUUID(), shotId, '2026-11-01T10:00:00Z', { sha256: sha(parentBytes) });
  p.assets = [parent];
  p.shots[0].winner = parent.id;
  p.edit = { clips: [{ id: randomUUID(), shotId, assetId: parent.id, in: 0, out: null }], updatedAt: '2026-11-01T10:00:00Z' };
  await mkdir(join(data, 'director', p.id, 'assets'), { recursive: true });
  await writeFile(join(data, 'director', p.id, parent.file), parentBytes);
  await writeFile(join(data, 'director', p.id, 'project.json'), JSON.stringify(p));

  const director = await openDirector(data);
  const routeCalls = [];
  const generation = { route: async (...a) => { routeCalls.push(a); throw Error('generation must not be called by accept'); } };
  let hold = null, encodes = 0;
  const encode = async ({ outMp4, width, height, fps, frameCount }) => {
    encodes++;
    if (hold) await hold.promise;
    const mp4 = Buffer.from(`fake-mp4:${outMp4}`); // unique per attempt, like a real encode
    await writeFile(outMp4, mp4);
    return { mp4, meta: { width, height, fps, frameCount, duration: frameCount / fps, audio: false } };
  };
  const api = openMaskedEdit(data, director, { log: () => {}, generation, encode });

  const editId = randomUUID(), reviewId = randomUUID();
  const composite = Buffer.from(`composite-${editId}`);
  const candidateSha256 = sha(composite);
  const dir = api.editDir(editId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'composite.rgb'), composite);
  await writeFile(join(dir, 'receipt.json'), JSON.stringify({
    v: 1, editId, projectId: p.id, shotId, sourceAssetId: parent.id, sourceSha256: parent.sha256,
    state: 'ready-for-review', candidateSha256, review: { id: reviewId },
    sourceTiming: { width: 1280, height: 720, fps: 24, frameCount: FRAMES, duration: FRAMES / 24 },
    maskHash: 'c'.repeat(64), featherPx: 8, cropRect: { x: 0, y: 0, w: 320, h: 480 },
    prompt: 'A red coat.', negativePrompt: '', seed: 1, inputKey: 'd'.repeat(64), quoteFingerprint: 'e'.repeat(64),
  }));
  const gate = () => { let release; const promise = new Promise(r => { release = r; }); hold = { promise, release }; return hold; };
  const input = extra => ({ projectId: p.id, editId, candidateSha256, reviewId, expectedRevision: 1, ...extra });
  const encodeStarted = async () => { while (!encodes) await new Promise(r => setImmediate(r)); };
  return { data, director, api, projectId: p.id, shotId, parent, editId, input, gate, encodeStarted, routeCalls, encodeCount: () => encodes };
}

const editTakes = (p, editId) => (p.assets || []).filter(a => a.source?.maskedEdit?.editId === editId);

test('a shot/cut edit made while acceptance encodes is kept; winner and cut are not changed by accept', async () => {
  const f = await fixture();
  const held = f.gate();
  const accepting = f.api.accept(f.input());
  await f.encodeStarted();

  // Intervening user edits while the encode is held: retitle the shot and trim the cut clip.
  const before = await f.director.get(f.projectId);
  const clip = before.edit.clips[0];
  await f.director.edit(f.projectId, [
    { op: 'update_shot', id: f.shotId, patch: { title: 'Retitled during encode' } },
    { op: 'set_edit', clips: [{ ...clip, in: 0.5, out: 2 }] },
  ]);
  held.release();
  const r = await accepting;

  assert.equal(r.accepted, true);
  assert.equal(r.replay, false);
  const p = await f.director.get(f.projectId);
  assert.equal(p.shots[0].title, 'Retitled during encode', 'intervening shot edit survived');
  assert.deepEqual(p.edit.clips.map(c => [c.assetId, c.in, c.out]), [[f.parent.id, 0.5, 2]], 'intervening cut edit survived; cut not switched to the new take');
  assert.equal(p.shots[0].winner, f.parent.id, 'winner unchanged');
  assert.deepEqual(editTakes(p, f.editId).map(a => a.id), [r.assetId]);
  assert.equal(r.revision, p.revision);
  assert.equal(f.routeCalls.length, 0, 'no generation.route calls');

  // Readback after restart: bytes on disk match, project lists the take, receipt is accepted.
  const reopened = await openDirector(f.data);
  const q = await reopened.get(f.projectId);
  const take = editTakes(q, f.editId)[0];
  assert.equal(take.id, r.assetId);
  assert.equal(sha(await readFile(join(f.data, 'director', f.projectId, take.file))), take.sha256);
  assert.equal(q.shots[0].title, 'Retitled during encode');
  const receipt = await f.api.loadReceipt(f.editId);
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.acceptance.assetId, r.assetId);
  assert.deepEqual((await readdir(join(f.data))).includes('director-archive'), false, 'no archive/restore cache bust');
  await rm(f.data, { recursive: true, force: true });
});

test('concurrent and replayed acceptance of the same candidate saves one take and loses no later edit', async () => {
  const f = await fixture();
  const held = f.gate();
  const a = f.api.accept(f.input({ acceptanceId: randomUUID() }));
  const b = f.api.accept(f.input({ acceptanceId: randomUUID() }));
  await f.encodeStarted();
  await f.director.edit(f.projectId, [{ op: 'update_shot', id: f.shotId, patch: { description: 'kept' } }]);
  held.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.assetId, rb.assetId);
  assert.equal(rb.replay, true);
  assert.equal(f.encodeCount(), 1, 'second request waited and replayed instead of encoding again');

  // A later replay (new acceptance id, same candidate) after another edit is still a no-op on the project.
  await f.director.edit(f.projectId, [{ op: 'update_shot', id: f.shotId, patch: { title: 'later' } }]);
  const revision = (await f.director.get(f.projectId)).revision;
  const rc = await f.api.accept(f.input({ acceptanceId: randomUUID(), expectedRevision: revision }));
  assert.equal(rc.replay, true);
  assert.equal(rc.assetId, ra.assetId);
  const p = await f.director.get(f.projectId);
  assert.equal(p.revision, revision, 'replay does not write the project');
  assert.equal(editTakes(p, f.editId).length, 1);
  assert.equal(p.shots[0].description, 'kept');
  assert.equal(p.shots[0].title, 'later');
  assert.equal(p.shots[0].winner, f.parent.id);
  assert.equal(f.routeCalls.length, 0);
  await rm(f.data, { recursive: true, force: true });
});

test('retry after a crash between saving the take and the receipt reuses the saved take', async () => {
  const f = await fixture();
  // First attempt saves the take, then "crashes" before the receipt is written (receipt still ready-for-review).
  const receiptPath = join(f.api.editDir(f.editId), 'receipt.json');
  const pending = await readFile(receiptPath);
  const first = await f.api.accept(f.input());
  await writeFile(receiptPath, pending);

  const director = await openDirector(f.data); // restart
  const api = openMaskedEdit(f.data, director, { encode: async ({ outMp4, width, height, fps, frameCount }) => {
    const mp4 = Buffer.from(`retry:${outMp4}`); await writeFile(outMp4, mp4);
    return { mp4, meta: { width, height, fps, frameCount, duration: frameCount / fps, audio: false } };
  } });
  const again = await api.accept(f.input({ expectedRevision: first.revision }));
  assert.equal(again.replay, true);
  assert.equal(again.assetId, first.assetId);
  const p = await director.get(f.projectId);
  assert.equal(editTakes(p, f.editId).length, 1);
  assert.equal((await api.loadReceipt(f.editId)).acceptance.assetId, first.assetId);
  await rm(f.data, { recursive: true, force: true });
});

test('removing the source shot while acceptance encodes refuses the take and leaves the project as edited', async () => {
  const f = await fixture();
  await f.director.edit(f.projectId, [{ op: 'add_shot', shot: { title: 'Other' } }]);
  const held = f.gate();
  const accepting = f.api.accept(f.input({ expectedRevision: (await f.director.get(f.projectId)).revision }));
  await f.encodeStarted();
  await f.director.edit(f.projectId, [{ op: 'remove_shot', id: f.shotId }]);
  const revision = (await f.director.get(f.projectId)).revision;
  held.release();
  await assert.rejects(accepting, e => e.status === 409 && /shot was removed/i.test(e.message));

  const p = await f.director.get(f.projectId);
  assert.equal(p.revision, revision, 'nothing written');
  assert.equal(editTakes(p, f.editId).length, 0);
  assert.equal(p.shots.some(s => s.id === f.shotId), false);
  assert.equal((await f.api.loadReceipt(f.editId)).state, 'ready-for-review', 'receipt not marked accepted');
  const files = await readdir(join(f.data, 'director', f.projectId, 'assets'));
  assert.deepEqual(files, [`${f.parent.id}.mp4`], 'no orphan take bytes in the project');
  assert.equal(f.routeCalls.length, 0);
  await rm(f.data, { recursive: true, force: true });
});

test('director append refuses a take whose parent bytes differ from the current source', async () => {
  const f = await fixture();
  const id = randomUUID(), bytes = Buffer.from('x');
  const asset = {
    id, kind: 'workflow-result', shotId: f.shotId, file: `assets/${id}.mp4`, mime: 'video/mp4', sha256: sha(bytes),
    source: { sourceAssetId: f.parent.id, maskedEdit: { v: 1, editId: f.editId, parentAssetId: f.parent.id, parentSha256: 'f'.repeat(64), compositeSha256: 'b'.repeat(64) } },
  };
  await assert.rejects(() => f.director.appendMaskedEditTake(f.projectId, { asset, bytes }), e => e.status === 409 && /source take changed/i.test(e.message));
  assert.equal(editTakes(await f.director.get(f.projectId), f.editId).length, 0);
  await rm(f.data, { recursive: true, force: true });
});
