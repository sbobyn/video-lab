// Masked-edit Take lab session: saved-receipt pointers, server-flag authority, unknown outcomes.
// Drives the real session controller with a fake request + storage; no DOM, browser or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const out = ts.transpileModule(readFileSync(new URL('../src/director-masked-edit.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const ui = {};
runInNewContext(out, {
  exports: ui,
  require: m => (String(m).includes('director-common') ? { h: () => { throw Error('no DOM in session tests'); }, toast: () => {}, DEMO: false } : {}),
});
const { createMaskedEditSession, rememberMaskedEditReceipt, savedMaskedEditReceipts, maskedEditView, MaskedEditRequestError, MAX_RECEIPT_POINTERS } = ui;

const P = '11111111-1111-4111-8111-111111111111', SHOT = '22222222-2222-4222-8222-222222222222';
const SRC = '33333333-3333-4333-8333-333333333333', SHA = 'a'.repeat(64);
const take = { projectId: P, shotId: SHOT, sourceAssetId: SRC, sourceSha256: SHA };

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
}

function status(editId, over = {}) {
  return {
    editId, state: 'prepared', draftRevision: 1, shotId: SHOT, sourceAssetId: SRC, sourceSha256: SHA,
    prompt: 'red parka', seed: 7, cropRect: { x: 0, y: 0, w: 480, h: 320 },
    quote: { estimate: 0.12, reservationRequiredUsd: 0.132 }, quoteFingerprint: 'f'.repeat(64), inputKey: 'k'.repeat(64),
    candidateSha256: null, review: null, acceptance: null, preservation: null, jobId: null, job: null,
    needsResume: false, canGenerate: true, canResume: false, canReview: false, canAccept: false,
    uncertain: false, previewMissing: false, preview: null,
    media: { candidate: null, mask: `masked-edit/media?projectId=${P}&editId=${editId}&file=mask.png` },
    ...over,
  };
}

/** Fake local server: a map of receipts and a handler per POST route; every call is logged. */
function fakeServer(routes = {}) {
  const receipts = new Map(), calls = [];
  const request = async (path, body) => {
    calls.push({ path: path.split('?')[0], body });
    if (path.startsWith('status?')) {
      const editId = new URLSearchParams(path.slice(7)).get('editId');
      if (!receipts.has(editId)) throw new MaskedEditRequestError('Unknown masked edit', 404);
      return structuredClone(receipts.get(editId));
    }
    const handler = routes[path];
    if (!handler) throw new MaskedEditRequestError(`unexpected ${path}`, 404);
    return handler(body, receipts);
  };
  return { receipts, calls, request, posts: () => calls.filter(c => !c.path.startsWith('status')).map(c => c.path) };
}

test('a saved edit is remembered only after the server returns its editId, per exact take, newest first', async () => {
  const storage = memoryStorage();
  let n = 0;
  const server = fakeServer({
    prepare: (body, receipts) => {
      if (body.prompt === 'ineligible') return { ok: false, editId: null, issues: [{ text: 'Source is 30 fps.' }] };
      const editId = `e${++n}`.padEnd(8, '0');
      receipts.set(editId, status(editId, { prompt: body.prompt }));
      return { ok: true, editId, sourceSha256: SHA };
    },
  });
  const session = createMaskedEditSession({ request: server.request, storage, take, uuid: () => 'u' });

  await session.prepare({ prompt: 'ineligible' });
  assert.equal(session.saved().length, 0);
  assert.match(session.state.note, /30 fps/);

  await session.prepare({ prompt: 'first' });
  assert.equal(session.state.status.prompt, 'first');
  session.startNewDraft();
  await session.prepare({ prompt: 'second' });
  assert.deepEqual([...session.saved().map(p => p.editId)], ['e2000000', 'e1000000']);
  assert.deepEqual(server.posts(), ['prepare', 'prepare', 'prepare'], 'prepare never submits');

  // Another take, shot, project or source bytes does not see these pointers.
  for (const other of [{ ...take, sourceAssetId: 'x' }, { ...take, shotId: 'x' }, { ...take, projectId: 'x' }, { ...take, sourceSha256: 'b'.repeat(64) }]) {
    assert.equal(savedMaskedEditReceipts(storage, other).length, 0);
  }

  // Reopen in a fresh dialog: the server receipt (not an empty form) is shown, read-only, with no POST.
  const reopened = createMaskedEditSession({ request: server.request, storage, take });
  await reopened.load(reopened.saved()[1].editId);
  const v = reopened.view();
  assert.equal(v.mode, 'prepared');
  assert.equal(reopened.state.status.prompt, 'first');
  assert.equal(v.canGenerate, true);
  assert.deepEqual(server.posts(), ['prepare', 'prepare', 'prepare']);
});

test('pointer storage is bounded and failure-tolerant; a status for a different source is refused', async () => {
  const storage = memoryStorage();
  for (let i = 0; i < MAX_RECEIPT_POINTERS + 3; i++) rememberMaskedEditReceipt(storage, { ...take, editId: `p${i}` });
  const kept = savedMaskedEditReceipts(storage, take);
  assert.equal(kept.length, MAX_RECEIPT_POINTERS);
  assert.equal(kept.at(-1).editId, 'p3', 'only the oldest pointers are forgotten');
  assert.deepEqual({ ...rememberMaskedEditReceipt(storage, { ...take, editId: 'p10' }) }, { saved: true, forgotten: 0 }, 'no duplicates');

  const broken = { getItem: () => '{not json', setItem: () => { throw Error('QuotaExceeded'); } };
  assert.equal(savedMaskedEditReceipts(broken, take).length, 0);
  assert.equal(rememberMaskedEditReceipt(broken, { ...take, editId: 'z' }).saved, false);
  assert.equal(rememberMaskedEditReceipt(null, { ...take, editId: 'z' }).saved, false);

  const server = fakeServer();
  server.receipts.set('other', status('other', { sourceAssetId: 'someone-else' }));
  const session = createMaskedEditSession({ request: server.request, storage, take });
  await session.load('other');
  assert.equal(session.state.status, null);
  assert.match(session.state.note, /different take/);
  await session.load('gone');
  assert.match(session.state.note, /not found.*pointer is kept/);
  assert.equal(savedMaskedEditReceipts(storage, take).length, MAX_RECEIPT_POINTERS);
});

test('missing preview follows server flags: no review/save, one explicit local retry, nothing on open', async () => {
  const editId = 'pv000000';
  let release;
  const server = fakeServer({
    resume: () => new Promise(r => { release = r; }),
    review: () => { throw Error('review must not be called'); },
    accept: () => { throw Error('accept must not be called'); },
  });
  server.receipts.set(editId, status(editId, {
    state: 'ready-for-review', candidateSha256: 'c'.repeat(64), canGenerate: false,
    canResume: true, canReview: false, canAccept: false, previewMissing: true,
    preview: { status: 'failed', message: 'Local preview unavailable. Retry Resume; no generation was submitted.' },
  }));
  const session = createMaskedEditSession({ request: server.request, storage: null, take });
  await session.load(editId);
  const v = session.view();
  assert.equal(v.mode, 'preview-failed');
  assert.deepEqual([v.showCandidate, v.canRecordReview, v.canAccept, v.canGenerate, v.canResume], [false, false, false, false, true]);
  assert.deepEqual(server.posts(), [], 'opening never resumes or generates');

  assert.equal(await session.recordReview(), false);
  assert.equal(await session.accept(3), false);
  const first = session.resume();
  assert.equal(session.state.busy, 'resume');
  assert.equal(session.view().canResume, false, 'controls are disabled while busy');
  assert.equal(await session.resume(), false, 'a second click while busy sends nothing');
  release(status(editId, {
    state: 'ready-for-review', candidateSha256: 'c'.repeat(64), canGenerate: false, canReview: true,
    media: { candidate: 'masked-edit/media?file=candidate.mp4', mask: 'masked-edit/media?file=mask.png' },
    preservation: { outsideExact: true }, preview: { status: 'ready' },
  }));
  await first;
  assert.deepEqual(server.posts(), ['resume']);
  assert.equal(session.view().mode, 'review');
  assert.equal(session.view().showCandidate, true);
  assert.equal(session.view().canAccept, false, 'no save before a recorded review');
});

test('unknown submit is reported as UNKNOWN, blocks Generate until refresh, then replays the same request id', async () => {
  const editId = 'sb000000', requestIds = [];
  let mode = 'network';
  const server = fakeServer({
    submit: (body, receipts) => {
      requestIds.push(body.requestId);
      assert.equal(body.approval.allowance.allowUnknownCharges, true);
      if (mode === 'network') throw new MaskedEditRequestError('No response from the local server.', null);
      if (mode === 'refused') throw new MaskedEditRequestError('maxCostUsd is below the required reservation', 400);
      if (mode === 'paid-off') throw new MaskedEditRequestError('Masked-edit submit requires the generation authority', 503);
      receipts.set(editId, status(editId, { state: 'submitted', jobId: 'j1', job: { status: 'running' }, canGenerate: false }));
      return { ok: true, replay: true, editId, jobId: 'j1', state: 'submitted' };
    },
  });
  server.receipts.set(editId, status(editId));
  let ids = 0;
  const session = createMaskedEditSession({ request: server.request, storage: null, take, uuid: () => `req-${++ids}` });
  await session.load(editId);

  assert.equal(await session.generate({ allowance: 0.5, scopeChecked: true, unknownAck: false }), false);
  assert.equal(await session.generate({ allowance: 0.1, scopeChecked: true, unknownAck: true }), false);
  assert.deepEqual(server.posts(), [], 'missing approval or allowance sends nothing');

  await session.generate({ allowance: 0.5, scopeChecked: true, unknownAck: true });
  assert.match(session.state.note, /UNKNOWN/);
  assert.doesNotMatch(session.state.note, /nothing was submitted|failed\.|refund/i);
  assert.equal(session.view().canGenerate, false, 'Generate blocked until status is refreshed');
  assert.equal(await session.generate({ allowance: 0.5, scopeChecked: true, unknownAck: true }), false);

  await session.refresh();
  assert.match(session.state.note, /still unknown.*same|request id/i);
  mode = 'refused';
  await session.generate({ allowance: 0.5, scopeChecked: true, unknownAck: true });
  assert.match(session.state.note, /^Refused: maxCostUsd/);
  mode = 'paid-off';
  await session.generate({ allowance: 0.5, scopeChecked: true, unknownAck: true });
  assert.match(session.state.note, /disabled here.*nothing was submitted/);
  mode = 'ok';
  await session.generate({ allowance: 0.5, scopeChecked: true, unknownAck: true });
  assert.deepEqual(requestIds, ['req-1', 'req-1', 'req-1', 'req-1'], 'one request id per draft, so the server replays instead of submitting twice');
  assert.equal(session.view().mode, 'running');
  assert.equal(session.view().canGenerate, false);

  server.receipts.set(editId, status(editId, { state: 'submitted', jobId: 'j1', job: { status: 'uncertain' }, uncertain: true, canGenerate: false, canResume: false }));
  await session.refresh();
  assert.equal(session.view().mode, 'uncertain');
  assert.match(session.state.note, /UNKNOWN.*Do not generate again/);
  assert.equal(session.view().canResume, false);
});

test('review then save: review id comes from the server, unknown save reuses the acceptance id, nothing is selected', async () => {
  const editId = 'ac000000', acceptCalls = [];
  let fail = true;
  const ready = over => status(editId, {
    state: 'ready-for-review', candidateSha256: 'c'.repeat(64), canGenerate: false, canReview: true,
    media: { candidate: 'masked-edit/media?file=candidate.mp4', mask: 'masked-edit/media?file=mask.png' }, ...over,
  });
  const server = fakeServer({
    review: (body, receipts) => {
      assert.equal(body.fingerprint, 'k'.repeat(64));
      receipts.set(editId, ready({ review: { id: 'rev-1' }, canAccept: true }));
      return { reviewId: 'rev-1', editId };
    },
    accept: (body, receipts) => {
      acceptCalls.push(body);
      if (fail) {
        // The server finished saving but the response was lost.
        receipts.set(editId, ready({ state: 'accepted', review: { id: 'rev-1' }, acceptance: { assetId: 'take-new-1' } }));
        throw new MaskedEditRequestError('Request failed (502)', 502);
      }
      return { accepted: true, replay: true, assetId: 'take-new-1' };
    },
  });
  server.receipts.set(editId, ready());
  let ids = 0;
  const session = createMaskedEditSession({ request: server.request, storage: null, take, uuid: () => `acc-${++ids}` });
  await session.load(editId);
  assert.equal(session.view().canAccept, false);
  await session.recordReview();
  assert.equal(session.state.status.review.id, 'rev-1');
  assert.equal(session.view().canRecordReview, false);
  assert.equal(session.view().canAccept, true);

  await session.accept(4);
  assert.match(session.state.note, /Save outcome UNKNOWN/);
  assert.equal(session.state.acceptUnknown, true);
  await session.refresh();
  assert.equal(session.view().mode, 'accepted');
  assert.match(session.state.note, /Saved as take take-new.*Winner and cut unchanged/);
  assert.equal(session.view().canAccept, false, 'accepted edits cannot be saved again');

  // A second dialog that was still at review retries with its own stable id; the server replays.
  fail = false;
  server.receipts.set(editId, ready({ review: { id: 'rev-1' }, canAccept: true }));
  await session.refresh();
  await session.accept(4);
  assert.deepEqual(acceptCalls.map(c => [c.acceptanceId, c.reviewId]), [['acc-1', 'rev-1'], ['acc-1', 'rev-1']]);
  assert.ok(acceptCalls.every(c => !('winner' in c) && !('cut' in c)));
});

test('responses that arrive after the dialog closes are dropped', async () => {
  let release;
  const changes = [];
  const session = createMaskedEditSession({
    request: () => new Promise(r => { release = r; }), storage: null, take, onChange: () => changes.push(1),
  });
  const pending = session.load('late0000');
  const before = changes.length;
  session.close();
  release(status('late0000'));
  await pending;
  assert.equal(session.state.status, null);
  assert.equal(changes.length, before, 'no redraw after close');
});

test('view never offers review or save from flags the server did not set', () => {
  const base = status('v0000000', { state: 'ready-for-review', candidateSha256: 'c'.repeat(64), canGenerate: false });
  assert.deepEqual(
    (({ showCandidate, canRecordReview, canAccept }) => ({ showCandidate, canRecordReview, canAccept }))(maskedEditView({ ...base, canReview: false, media: { candidate: 'x' } })),
    { showCandidate: false, canRecordReview: false, canAccept: false });
  assert.equal(maskedEditView({ ...base, canReview: true, canAccept: true, review: null, media: { candidate: 'x' } }).canAccept, false);
  assert.equal(maskedEditView(status('v', { state: 'submitted', job: { status: 'failed' }, canGenerate: false })).mode, 'job-failed');
  assert.equal(maskedEditView(status('v', { state: 'failed-local', canGenerate: false, canResume: true })).mode, 'resume');
});
