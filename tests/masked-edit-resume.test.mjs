// Saved-job local recovery for masked edits: resume / status / preview retry. Offline — injected probe,
// decode and encode seams; no ffmpeg, no provider, no generation dispatch. Synthetic two-frame fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDirector, createProjectDocument } from '../server/previs/director.mjs';
import { openMaskedEdit } from '../server/previs/masked-edit.mjs';
import { rasterizeFixedMask, cropFromMask } from '../shared/masked-edit.mjs';
import { rectMask, rgbFrame, videoAsset } from './fixtures/masked-edit/helpers.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'previs-me-resume-'));
  const projectId=randomUUID(), shotId=randomUUID(), editId=randomUUID(), assetId=randomUUID(), jobId=randomUUID();
  const source=Buffer.from('synthetic source video'), patch=Buffer.from('synthetic patch video');
  const sourceFile=join(root,'source.mp4'), patchFile='patch.mp4';
  await mkdir(join(root,'assets')); await writeFile(sourceFile,source); await writeFile(join(root,'assets',patchFile),patch);
  const mask=rasterizeFixedMask(rectMask({x:200,y:200,w:240,h:240,featherPx:4}));
  const crop=cropFromMask(mask.alpha,1280,720);
  const project={id:projectId,revision:7,shots:[{id:shotId,winner:'keep-winner'}],assets:[{id:assetId,shotId,kind:'workflow-result',mime:'video/mp4',file:'assets/source.mp4',sha256:sha(source)}],edit:{clips:[{shotId,assetId:'keep-winner'}]}};
  let dispatch=0, encodes=0, decodeCount=0;
  const job={id:jobId,status:'uncertain',purpose:'masked-edit-patch',results:[]};
  let failEncode=false;
  const opts={generation:{list:()=>[structuredClone(job)],route:async()=>{dispatch++;throw Error('Forbidden dispatch');}},
    probeVideo:async()=>({width:1280,height:720,fps:24,frameCount:2,audio:false}),
    decodeFrames:async(file,w,h,n)=>{decodeCount++;return Array.from({length:n},()=>rgbFrame(w,h,file===sourceFile?[20,30,40]:[180,10,30]));},
    encodePreview:async(receipt,file)=>{encodes++;if(failEncode)throw Error('fixture encode unavailable');await writeFile(file,Buffer.from('synthetic preview'));return file;}};
  const director={get:async()=>structuredClone(project),assetFile:async()=>sourceFile};
  const open=()=>openMaskedEdit(root,director,opts);
  const api=open(), dir=api.editDir(editId);await mkdir(dir,{recursive:true});await writeFile(join(dir,'mask.bin'),Buffer.from(mask.alpha));
  const receipt={v:1,editId,draftRevision:1,state:'submitted',projectId,shotId,sourceAssetId:assetId,sourceSha256:sha(source),maskHash:mask.maskHash,featherPx:4,cropRect:{x:crop.x,y:crop.y,w:crop.w,h:crop.h},sourceTiming:{width:1280,height:720,fps:24,frameCount:2,duration:2/24},inputKey:'a'.repeat(64),jobId,review:null,acceptance:null,preservation:null};
  await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt));
  return {api,open,project,job,crop,dir,root,projectId,editId,patch,patchFile,opts,counts:()=>({dispatch,encodes,decodeCount}),failEncode:value=>{failEncode=value;}};
}

test('uncertain receipt reconciles a later completed saved job across restart without dispatch or selection',async()=>{
  const f=await fixture(), input={projectId:f.projectId,editId:f.editId}, before=structuredClone(f.project);
  await assert.rejects(f.api.resume(input),/uncertain/);
  assert.equal((await f.api.loadReceipt(f.editId)).state,'uncertain');
  assert.equal(f.counts().dispatch,0);
  f.job.status='completed';f.job.results=[{id:randomUUID(),kind:'video',filename:f.patchFile,sha256:sha(f.patch),width:f.crop.w,height:f.crop.h,frameCount:2}];
  const reopened=f.open();
  const status=await reopened.status(input);assert.equal(status.canGenerate,false);assert.equal(status.canResume,true);assert.equal(status.uncertain,false);
  const ready=await reopened.resume(input);
  assert.equal(ready.state,'ready-for-review');assert.equal(ready.canGenerate,false);assert.equal(ready.canAccept,false);
  assert.equal((await reopened.loadReceipt(f.editId)).patchJobId,f.job.id);
  assert.deepEqual(f.counts(),{dispatch:0,encodes:1,decodeCount:2});assert.deepEqual(f.project,before);
  assert.equal((await f.open().status(input)).candidateSha256,ready.candidateSha256);
});

test('missing or still-unknown job cannot be promoted after restart',async()=>{
  const f=await fixture(),input={projectId:f.projectId,editId:f.editId};
  await assert.rejects(f.api.resume(input),/uncertain/);
  for(const jobs of [[],[f.job]]){
    const api=openMaskedEdit(f.root,{get:async()=>f.project},{...f.opts,generation:{list:()=>jobs,route:async()=>assert.fail('Forbidden route')}});
    await assert.rejects(api.resume(input),/uncertain/);
    assert.equal((await api.loadReceipt(f.editId)).state,'uncertain');
  }
  assert.deepEqual(f.counts(),{dispatch:0,encodes:0,decodeCount:0});
});

test('failed/missing preview is actionable across restart and retries only verified local composite',async()=>{
  const f=await fixture(), input={projectId:f.projectId,editId:f.editId}, before=structuredClone(f.project);
  f.job.status='completed';f.job.results=[{id:randomUUID(),kind:'video',filename:f.patchFile,sha256:sha(f.patch),width:f.crop.w,height:f.crop.h,frameCount:2}];
  f.failEncode(true);
  await assert.rejects(f.api.resume(input),/Local preview unavailable/);
  const saved=await f.api.loadReceipt(f.editId);
  assert.equal(saved.state,'ready-for-review');assert.equal(saved.preview.status,'failed');
  const blocked=await f.open().status(input);
  assert.equal(blocked.canResume,true);assert.equal(blocked.canReview,false);assert.equal(blocked.canAccept,false);assert.equal(blocked.media.candidate,null);
  f.failEncode(false);
  const ready=await f.open().resume(input);
  assert.equal(ready.candidateSha256,saved.candidateSha256);assert.equal(ready.canReview,true);
  const reviewed=await f.open().review({...input,candidateSha256:saved.candidateSha256,sourceSha256:saved.sourceSha256,fingerprint:saved.inputKey,reviewedScope:true});
  const {rename}=await import('node:fs/promises');
  await rename(join(f.dir,'candidate.mp4'),join(f.dir,'candidate-held.mp4'));
  assert.equal((await f.open().status(input)).previewMissing,true);
  const resumed=await f.open().resume(input);
  assert.equal(resumed.review.id,reviewed.reviewId,'same composite retains its deliberate review');
  assert.equal(resumed.canAccept,true);assert.deepEqual(f.project,before);
  assert.deepEqual(f.counts(),{dispatch:0,encodes:3,decodeCount:2});
  // Reject changed composite bytes before any encoding or provider dispatch.
  await rename(join(f.dir,'candidate.mp4'),join(f.dir,'candidate-second-held.mp4'));
  await writeFile(join(f.dir,'composite.rgb'),Buffer.from('tampered fixture'));
  await assert.rejects(f.open().resume(input),/Candidate bytes changed/);
  assert.deepEqual(f.counts(),{dispatch:0,encodes:3,decodeCount:2});
});

// End-to-end against a real Director store and the queued publication path (director.appendMaskedEditTake).
test('restart resume of a later-completed uncertain job -> review -> accept keeps intervening edits, zero dispatch', async () => {
  const data = await mkdtemp(join(tmpdir(), 'previs-me-resume-e2e-'));
  const p = createProjectDocument({ title: 'Resume' }, randomUUID(), []);
  const shotId = p.shots[0].id;
  const parentBytes = Buffer.from('parent-take');
  const parent = videoAsset(randomUUID(), shotId, '2026-11-01T10:00:00Z', { sha256: sha(parentBytes) });
  p.assets = [parent];
  p.shots[0].winner = parent.id;
  p.edit = { clips: [{ id: randomUUID(), shotId, assetId: parent.id, in: 0, out: null }], updatedAt: '2026-11-01T10:00:00Z' };
  await mkdir(join(data, 'director', p.id, 'assets'), { recursive: true });
  await writeFile(join(data, 'director', p.id, parent.file), parentBytes);
  await writeFile(join(data, 'director', p.id, 'project.json'), JSON.stringify(p));

  const mask = rasterizeFixedMask(rectMask({ x: 200, y: 200, w: 240, h: 240, featherPx: 4 }));
  const crop = cropFromMask(mask.alpha, 1280, 720);
  const editId = randomUUID(), jobId = randomUUID();
  const patchBytes = Buffer.from('synthetic patch video');
  await mkdir(join(data, 'assets'), { recursive: true });
  await writeFile(join(data, 'assets', 'patch.mp4'), patchBytes);
  const job = { id: jobId, status: 'uncertain', purpose: 'masked-edit-patch', results: [] };

  let dispatch = 0, decodes = 0, previews = 0, encodes = 0, hold = null;
  const opts = {
    generation: { list: () => [structuredClone(job)], route: async () => { dispatch++; throw Error('Forbidden dispatch'); } },
    probeVideo: async () => ({ width: 1280, height: 720, fps: 24, frameCount: 2, audio: false }),
    decodeFrames: async (file, w, h, n) => { decodes++; return Array.from({ length: n }, () => rgbFrame(w, h, file.endsWith('patch.mp4') ? [180, 10, 30] : [20, 30, 40])); },
    encodePreview: async (_receipt, file) => { previews++; await writeFile(file, Buffer.from('synthetic preview')); return file; },
    encode: async ({ outMp4, width, height, fps, frameCount }) => {
      encodes++;
      if (hold) await hold.promise;
      const mp4 = Buffer.from(`fake-mp4:${outMp4}`);
      await writeFile(outMp4, mp4);
      return { mp4, meta: { width, height, fps, frameCount, duration: frameCount / fps, audio: false } };
    },
  };
  let director = await openDirector(data);
  let api = openMaskedEdit(data, director, opts);
  const dir = api.editDir(editId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mask.bin'), Buffer.from(mask.alpha));
  await writeFile(join(dir, 'receipt.json'), JSON.stringify({
    v: 1, editId, draftRevision: 1, state: 'uncertain', projectId: p.id, shotId, sourceAssetId: parent.id, sourceSha256: parent.sha256,
    maskHash: mask.maskHash, featherPx: 4, cropRect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    sourceTiming: { width: 1280, height: 720, fps: 24, frameCount: 2, duration: 2 / 24 },
    prompt: 'A red coat.', negativePrompt: '', seed: 1, inputKey: 'd'.repeat(64), quoteFingerprint: 'e'.repeat(64),
    jobId, review: null, acceptance: null, preservation: null,
  }));
  const input = { projectId: p.id, editId };

  // Unknown outcome: blocked, nothing dispatched or decoded.
  await assert.rejects(api.resume(input), e => e.status === 409 && /uncertain/.test(e.message));
  assert.equal((await api.status(input)).canGenerate, false);

  // The saved job later completes; restart the director and masked-edit service.
  job.status = 'completed';
  job.results = [{ id: randomUUID(), kind: 'video', filename: 'patch.mp4', sha256: sha(patchBytes), width: crop.w, height: crop.h, frameCount: 2 }];
  director = await openDirector(data);
  api = openMaskedEdit(data, director, opts);
  const st = await api.status(input);
  assert.deepEqual([st.canResume, st.canGenerate, st.canAccept, st.uncertain], [true, false, false, false]);

  const revisionBefore = (await director.get(p.id)).revision;
  const ready = await api.routes('POST', new URL('http://127.0.0.1/api/director/masked-edit/resume'), input);
  assert.equal(ready.state, 'ready-for-review');
  assert.equal(ready.patchJobId, jobId);
  assert.equal((await api.mediaFile({ ...input, file: 'candidate.mp4' })).contentType, 'video/mp4');
  await assert.rejects(api.mediaFile({ ...input, file: 'composite.rgb' }), e => e.status === 404);
  await assert.rejects(api.mediaFile({ projectId: randomUUID(), editId, file: 'candidate.mp4' }), e => e.status === 404);
  assert.equal(ready.canAccept, false, 'resume never auto-reviews or auto-selects');
  let proj = await director.get(p.id);
  assert.equal(proj.revision, revisionBefore, 'resume does not write the project');
  assert.equal(proj.assets.length, 1);

  const { reviewId } = await api.review({ ...input, candidateSha256: ready.candidateSha256, sourceSha256: parent.sha256, fingerprint: 'd'.repeat(64), reviewedScope: true });
  assert.equal((await api.status(input)).canAccept, true);

  // Accept while the user keeps editing; the take is appended on the director queue.
  let release; hold = { promise: new Promise(r => { release = r; }) };
  const accepting = api.accept({ ...input, candidateSha256: ready.candidateSha256, reviewId, expectedRevision: revisionBefore });
  while (!encodes) await new Promise(r => setImmediate(r));
  await director.edit(p.id, [{ op: 'update_shot', id: shotId, patch: { title: 'Retitled during accept' } }]);
  release();
  const accepted = await accepting;
  assert.equal(accepted.replay, false);

  proj = await director.get(p.id);
  const takes = proj.assets.filter(a => a.source?.maskedEdit?.editId === editId);
  assert.deepEqual(takes.map(a => a.id), [accepted.assetId]);
  assert.equal(takes[0].source.maskedEdit.patchJobId, jobId);
  assert.equal(proj.shots[0].title, 'Retitled during accept', 'intervening edit kept');
  assert.equal(proj.shots[0].winner, parent.id, 'winner unchanged');
  assert.deepEqual(proj.edit.clips.map(c => c.assetId), [parent.id], 'cut unchanged');

  // Replays after restart are no-ops: resume reports accepted, accept returns the same take.
  director = await openDirector(data);
  api = openMaskedEdit(data, director, opts);
  assert.equal((await api.resume(input)).state, 'accepted');
  const again = await api.accept({ ...input, candidateSha256: ready.candidateSha256, reviewId, expectedRevision: proj.revision });
  assert.equal(again.replay, true);
  assert.equal(again.assetId, accepted.assetId);
  assert.equal((await director.get(p.id)).assets.filter(a => a.source?.maskedEdit?.editId === editId).length, 1);
  assert.deepEqual({ dispatch, decodes, previews, encodes }, { dispatch: 0, decodes: 2, previews: 1, encodes: 1 });
  await rm(data, { recursive: true, force: true });
});
