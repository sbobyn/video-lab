// Fixed-mask region edit UI for Take lab (experimental). Authoring → saved draft → approved submit →
// explicit local resume → review → save as a child take. The server receipt is the authority;
// this browser only remembers edit ids. Paid submit stays gated; nothing here retries Cloud.
import { h, toast, DEMO } from './director-common';
import type { DirectorProject, Asset, Shot } from '../shared/director.mjs';
import type { VideoTake } from '../shared/takes.mjs';

export const MASKED_EDIT_FRAMES = [81, 89, 113] as const;
export const MASKED_EDIT_SIZE: { width: number; height: number; fps: number } = { width: 1280, height: 720, fps: 24 };
const FEATHER_DEFAULT = 8;
const MAX_STROKES = 64;
const MAX_POINTS = 4000;

export type MaskStroke = { tool: 'brush' | 'erase'; size: number; points: { x: number; y: number }[] };
export type FixedMask = {
  v: 1; mode: 'fixed'; width: number; height: number; coordinateSpace: 'source-pixels';
  strokes: MaskStroke[]; featherPx: number;
  rect?: { x: number; y: number; w: number; h: number };
};

export type MaskedEditCtx = {
  project(): DirectorProject;
  assetUrl(a: Asset): string;
  focusReturn?: HTMLElement | null;
};

/** Offline-safe eligibility for the fixed-mask envelope (UX-AND-TESTS.md). */
export function maskedEditEligibility(asset: Pick<Asset, 'kind' | 'mime' | 'width' | 'height' | 'fps' | 'frameCount' | 'duration'> | null | undefined) {
  if (!asset) return { ok: false as const, reason: 'This take’s original media or provenance is unavailable. Restore it before editing.' };
  const a = asset;
  if (a.width !== MASKED_EDIT_SIZE.width || a.height !== MASKED_EDIT_SIZE.height
    || a.fps !== MASKED_EDIT_SIZE.fps
    || !MASKED_EDIT_FRAMES.includes(a.frameCount as typeof MASKED_EDIT_FRAMES[number])) {
    return {
      ok: false as const,
      reason: 'This preview supports silent 720p / 24 fps takes with 81, 89 or 113 frames. Nothing changed.',
      detail: `This take: ${a.width}×${a.height} · ${a.fps} fps · ${a.frameCount} frames.`,
    };
  }
  return { ok: true as const };
}

/** Planning estimate mirror of server estimateMaskedVaceCost (crop-scaled historical calibration). */
export function estimateMaskedEditUsd(crop: { width: number; height: number }, frames: number) {
  const basisGpu = 248.2, basisPx = 399_360, basisFrames = 81;
  const gpu = basisGpu * ((crop.width * crop.height) / basisPx) * (frames / basisFrames);
  const estimate = Math.round((gpu * 0.266 / 211) * 10000) / 10000;
  const reservationRequiredUsd = Math.round(estimate * 1.1 * 10000) / 10000;
  return { estimate, reservationRequiredUsd, currency: 'USD' as const, providerEnforcedCap: false as const };
}

/** Axis-aligned crop around nonzero painted support + pad, 16-aligned, minima from INTEGRATION.md. */
export function cropAroundMask(mask: FixedMask, frame = MASKED_EDIT_SIZE) {
  let minX = frame.width, minY = frame.height, maxX = -1, maxY = -1;
  if (mask.rect && mask.rect.w > 0 && mask.rect.h > 0) {
    minX = Math.floor(mask.rect.x); minY = Math.floor(mask.rect.y);
    maxX = Math.ceil(mask.rect.x + mask.rect.w) - 1; maxY = Math.ceil(mask.rect.y + mask.rect.h) - 1;
  }
  for (const s of mask.strokes) for (const p of s.points) {
    const r = Math.ceil(s.size / 2);
    minX = Math.min(minX, Math.floor(p.x - r)); minY = Math.min(minY, Math.floor(p.y - r));
    maxX = Math.max(maxX, Math.ceil(p.x + r)); maxY = Math.max(maxY, Math.ceil(p.y + r));
  }
  if (maxX < minX || maxY < minY) return null;
  const pad = 32;
  let x = Math.max(0, minX - pad), y = Math.max(0, minY - pad);
  let w = Math.min(frame.width, maxX + pad + 1) - x, h = Math.min(frame.height, maxY + pad + 1) - y;
  const grow = (need: number, cur: number, roomBefore: number, roomAfter: number) => {
    let add = Math.max(0, need - cur), before = Math.min(roomBefore, Math.ceil(add / 2)), after = Math.min(roomAfter, add - before);
    before += Math.min(roomBefore - before, add - before - after);
    return { before, after: add - before > after ? after + (add - before - after) : after };
  };
  while (w < 320 || h < 320 || w * h < 153_600) {
    if (w < 320 || w * h < 153_600) {
      const g = grow(Math.max(320, Math.ceil(153_600 / Math.max(h, 1))), w, x, frame.width - x - w);
      x -= g.before; w += g.before + g.after;
    }
    if (h < 320 || w * h < 153_600) {
      const g = grow(Math.max(320, Math.ceil(153_600 / Math.max(w, 1))), h, y, frame.height - y - h);
      y -= g.before; h += g.before + g.after;
    }
    if (x === 0 && y === 0 && w === frame.width && h === frame.height) break;
  }
  const align = (v: number, max: number, size: boolean) => {
    if (size) return Math.min(max, Math.ceil(v / 16) * 16);
    return Math.max(0, Math.floor(v / 16) * 16);
  };
  x = align(x, frame.width, false); y = align(y, frame.height, false);
  w = align(w, frame.width - x, true); h = align(h, frame.height - y, true);
  if (w * h > frame.width * frame.height * 0.6) return { ok: false as const, reason: 'This crop covers more than 60% of the frame. Region editing may not save money. Choose a smaller region.', crop: { x, y, w, h } };
  return { ok: true as const, crop: { x, y, w, h } };
}

export function emptyMask(width = MASKED_EDIT_SIZE.width, height = MASKED_EDIT_SIZE.height): FixedMask {
  return { v: 1, mode: 'fixed', width, height, coordinateSpace: 'source-pixels', strokes: [], featherPx: FEATHER_DEFAULT };
}

// ---- saved receipts + session (no DOM; tests drive these with a fake request and storage)

export type MaskedEditStatus = {
  editId: string; state: string; draftRevision?: number;
  shotId?: string; sourceAssetId: string; sourceSha256: string;
  prompt?: string; seed?: number; maskHash?: string;
  cropRect?: { x: number; y: number; w: number; h: number } | null;
  candidateSha256?: string | null;
  review?: { id: string } | null;
  acceptance?: { assetId: string } | null;
  preservation?: { outsideExact?: boolean } | null;
  quote?: { estimate?: number | null; reservationRequiredUsd?: number | null } | null;
  quoteFingerprint?: string; inputKey?: string;
  jobId?: string | null; job?: { status?: string } | null;
  needsResume?: boolean; canGenerate?: boolean; canResume?: boolean; canReview?: boolean; canAccept?: boolean;
  uncertain?: boolean; previewMissing?: boolean; preview?: { status?: string; message?: string } | null;
  media?: { candidate?: string | null; mask?: string | null };
};
export type TakeIdentity = { projectId: string; shotId: string; sourceAssetId: string; sourceSha256?: string };
export type ReceiptPointer = { projectId: string; shotId: string; sourceAssetId: string; sourceSha256: string; editId: string; savedAt: string };
export type KV = Pick<Storage, 'getItem' | 'setItem'>;

/** Browser-local list of server-issued edit ids. Pointers only: receipts, masks and media stay on the local server. */
export const RECEIPT_POINTERS_KEY = 'previs.maskedEdit.receipts.v1';
export const MAX_RECEIPT_POINTERS = 40;

export function browserStorage(): KV | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readPointers(store: KV | null): ReceiptPointer[] {
  try {
    const list = JSON.parse(store?.getItem(RECEIPT_POINTERS_KEY) || '[]');
    return Array.isArray(list) ? list.filter(p => p && typeof p.editId === 'string' && typeof p.projectId === 'string' && typeof p.sourceAssetId === 'string') : [];
  } catch { return []; }
}

/** Record an editId the server returned. Past the cap the oldest pointers are forgotten; their receipts stay on disk. */
export function rememberMaskedEditReceipt(store: KV | null, p: Omit<ReceiptPointer, 'savedAt'>, savedAt = new Date().toISOString()) {
  const list = readPointers(store);
  if (list.some(x => x.editId === p.editId)) return { saved: true, forgotten: 0 };
  list.push({ ...p, savedAt });
  const forgotten = Math.max(0, list.length - MAX_RECEIPT_POINTERS);
  try {
    if (!store) return { saved: false, forgotten: 0 };
    store.setItem(RECEIPT_POINTERS_KEY, JSON.stringify(list.slice(forgotten)));
    return { saved: true, forgotten };
  } catch { return { saved: false, forgotten: 0 }; }
}

/** Saved edits for this exact project, shot, source take and (when known) source bytes; newest first. */
export function savedMaskedEditReceipts(store: KV | null, take: TakeIdentity) {
  return readPointers(store).filter(p => p.projectId === take.projectId && p.shotId === take.shotId && p.sourceAssetId === take.sourceAssetId
    && (!take.sourceSha256 || !p.sourceSha256 || p.sourceSha256 === take.sourceSha256)).reverse();
}

export function statusMatchesTake(st: Pick<MaskedEditStatus, 'shotId' | 'sourceAssetId' | 'sourceSha256'>, take: TakeIdentity) {
  return st.sourceAssetId === take.sourceAssetId && (!st.shotId || st.shotId === take.shotId)
    && (!take.sourceSha256 || st.sourceSha256 === take.sourceSha256);
}

const short = (id: string | null | undefined) => (id ? String(id).slice(0, 8) : '—');
const JOB_ENDED = ['failed', 'closed', 'orphaned', 'recovery-required'];

export type MaskedEditMode = 'prepared' | 'running' | 'resume' | 'preview-failed' | 'uncertain' | 'job-failed' | 'review' | 'accepted' | 'blocked';

/** What the server's receipt allows. The server flags are the authority; nothing here is inferred from elapsed time. */
export function maskedEditView(st: MaskedEditStatus) {
  const flags = {
    canGenerate: Boolean(st.canGenerate) && !st.uncertain,
    canResume: Boolean(st.canResume) && !st.uncertain,
    showCandidate: Boolean(st.canReview) && Boolean(st.media?.candidate),
    canRecordReview: Boolean(st.canReview) && st.state === 'ready-for-review' && !st.review?.id,
    canAccept: Boolean(st.canAccept) && Boolean(st.review?.id),
  };
  let mode: MaskedEditMode, message: string;
  if (st.state === 'accepted') {
    mode = 'accepted'; message = `Saved as take ${short(st.acceptance?.assetId)}. Winner and cut unchanged.`;
  } else if (st.uncertain) {
    mode = 'uncertain'; message = 'The patch job outcome is UNKNOWN. It may still finish or be billed. Do not generate again; check Jobs, then refresh status.';
  } else if (st.state === 'ready-for-review' && st.previewMissing) {
    mode = 'preview-failed'; message = `${st.preview?.message || 'The local preview is unavailable.'} The verified composite is kept; Retry preview runs locally and submits nothing.`;
  } else if (st.state === 'ready-for-review') {
    mode = 'review'; message = st.review?.id ? 'Review recorded. Save as a new take when ready; nothing is selected for you.' : 'Ready for review. Compare Original, Edited and Mask, then record your review.';
  } else if (st.state === 'prepared') {
    mode = 'prepared'; message = 'Saved draft. Nothing has been submitted.';
  } else if (JOB_ENDED.includes(String(st.job?.status))) {
    mode = 'job-failed'; message = `The patch job ended ${st.job!.status}; there is nothing to composite. Check Jobs for any charge.`;
  } else if (flags.canResume) {
    mode = 'resume'; message = st.state === 'failed-local'
      ? 'The local composite failed. Resume retries locally from the saved patch; no Cloud request.'
      : 'The Cloud patch is ready. Resume composites it locally; no Cloud request.';
  } else if (['submitted', 'compositing', 'verifying'].includes(st.state)) {
    mode = 'running'; message = `Submitted${st.job?.status ? ` · job ${st.job.status}` : ''}. Refresh status to check. Original and cut are unchanged.`;
  } else {
    mode = 'blocked'; message = `This edit is ${st.state}. No action is available here.`;
  }
  return { mode, message, ...flags };
}

export class MaskedEditRequestError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) { super(message); this.status = status; }
}
export type MaskedEditRequest = <T = any>(path: string, body?: unknown) => Promise<T>;

/** JSON request to /api/director/masked-edit/*. A missing response keeps status null: the outcome is unknown. */
export const maskedEditRequest: MaskedEditRequest = async (path, body) => {
  let response: Response;
  try {
    response = await fetch('/api/director/masked-edit/' + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new MaskedEditRequestError('No response from the local server.', null); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new MaskedEditRequestError(data?.error || `Request failed (${response.status})`, response.status);
  return data;
};

const PAID_OFF = /generation authority|PREVIS_ALLOW_PAID|Paid and unknown|disabled at this checkpoint/i;

/** Only a definite refusal means nothing was sent; no response or a server error leaves the outcome unknown. */
export function submitOutcome(e: unknown) {
  const status = e instanceof MaskedEditRequestError ? e.status : null;
  const msg = (e as Error)?.message || 'Request failed';
  if (status !== null && PAID_OFF.test(msg)) return { kind: 'paid-disabled' as const, text: 'Paid Cloud submit is disabled here (needs PREVIS_ALLOW_PAID=1 and an approved budget). Draft kept; nothing was submitted.' };
  if (status !== null && status < 500) return { kind: 'refused' as const, text: `Refused: ${msg} Draft kept.` };
  return { kind: 'unknown' as const, text: 'Submit outcome UNKNOWN: no definite answer, so the edit may or may not have reached Cloud and may be billed. Do not assume it failed or was free. Refresh status first; Generate is blocked until then and would reuse the same request id.' };
}

export function createMaskedEditSession(o: { request: MaskedEditRequest; storage: KV | null; take: TakeIdentity; uuid?: () => string; onChange?: () => void }) {
  const uuid = o.uuid || (() => crypto.randomUUID());
  const s = {
    status: null as MaskedEditStatus | null, busy: null as string | null, note: '', closed: false,
    submitUnknown: false, acceptUnknown: false,
  };
  const submitIds = new Map<string, string>(), acceptIds = new Map<string, string>();
  const changed = () => { if (!s.closed) o.onChange?.(); };
  const statusPath = (editId: string) => `status?projectId=${encodeURIComponent(o.take.projectId)}&editId=${encodeURIComponent(editId)}`;
  const errText = (e: unknown) => (e as Error)?.message || 'Request failed';

  /** One operation at a time; responses that land after close are dropped. */
  async function run(kind: string, fn: () => Promise<void>) {
    if (s.busy || s.closed) return false;
    s.busy = kind; changed();
    try { await fn(); } finally { s.busy = null; changed(); }
    return true;
  }
  async function readStatus(editId: string, lead = '') {
    const st = await o.request<MaskedEditStatus>(statusPath(editId));
    if (s.closed) return;
    if (!statusMatchesTake(st, o.take)) { s.status = null; s.note = 'That saved edit belongs to a different take or source version. Nothing changed.'; return; }
    const wasPrepared = s.submitUnknown && st.state === 'prepared';
    s.status = st; s.submitUnknown = false; s.acceptUnknown = false;
    s.note = (lead ? lead + ' ' : '') + maskedEditView(st).message
      + (wasPrepared ? ' The earlier submit outcome is still unknown; Generate reuses its request id, so the server replays it instead of submitting twice.' : '');
  }
  const refreshCatch = (e: unknown) => {
    if (s.closed) return;
    s.note = e instanceof MaskedEditRequestError && e.status === 404
      ? 'This saved edit was not found on the local server. Its pointer is kept; nothing changed.'
      : `Could not read status: ${errText(e)}`;
  };

  function view() {
    const st = s.status;
    if (!st) return null;
    const v = maskedEditView(st), idle = !s.busy;
    return { ...v, canGenerate: v.canGenerate && idle && !s.submitUnknown, canResume: v.canResume && idle, canRecordReview: v.canRecordReview && idle, canAccept: v.canAccept && idle };
  }

  return {
    state: s,
    view,
    saved: () => savedMaskedEditReceipts(o.storage, o.take),
    load: (editId: string) => run('status', () => readStatus(editId).catch(refreshCatch)),
    refresh: () => (s.status ? run('status', () => readStatus(s.status!.editId).catch(refreshCatch)) : Promise.resolve(false)),
    /** Prepare stores the draft on the server; only a returned editId is remembered locally. */
    prepare: (input: Record<string, unknown>) => run('prepare', async () => {
      try {
        const r = await o.request<any>('prepare', { ...input, projectId: o.take.projectId, shotId: o.take.shotId, sourceAssetId: o.take.sourceAssetId, sourceSha256: o.take.sourceSha256 });
        if (s.closed) return;
        if (!r?.ok || !r.editId) { s.note = r?.issues?.[0]?.text || 'This take is not eligible. Nothing was saved.'; return; }
        const kept = rememberMaskedEditReceipt(o.storage, { projectId: o.take.projectId, shotId: o.take.shotId, sourceAssetId: o.take.sourceAssetId, sourceSha256: r.sourceSha256 || o.take.sourceSha256 || '', editId: r.editId });
        await readStatus(r.editId, kept.saved ? 'Draft saved on the local server.' : 'Draft saved on the local server; this browser could not remember it, so note edit ' + short(r.editId) + '.');
      } catch (e) { if (!s.closed) s.note = errText(e); }
    }),
    generate: (a: { allowance: number; scopeChecked: boolean; unknownAck: boolean }) => {
      const st = s.status, v = view();
      if (!st || !v?.canGenerate) return Promise.resolve(false);
      const reserve = Number(st.quote?.reservationRequiredUsd);
      if (!a.scopeChecked || !a.unknownAck) { s.note = 'Confirm the region scope and the unknown-charge acknowledgement first. Nothing submitted.'; changed(); return Promise.resolve(false); }
      if (!Number.isFinite(reserve) || !st.quoteFingerprint) { s.note = 'No reliable estimate is saved for this draft. Nothing submitted.'; changed(); return Promise.resolve(false); }
      if (!(a.allowance >= reserve)) { s.note = 'The required reservation exceeds your run allowance. Nothing submitted.'; changed(); return Promise.resolve(false); }
      const requestId = submitIds.get(st.editId) || uuid();
      submitIds.set(st.editId, requestId);
      return run('generate', async () => {
        try {
          const r = await o.request<any>('submit', {
            projectId: o.take.projectId, editId: st.editId, draftRevision: st.draftRevision ?? 1, requestId,
            fingerprint: st.quoteFingerprint, maxCostUsd: a.allowance,
            approval: { approved: true, fingerprint: st.quoteFingerprint, allowance: { currency: 'USD', maxAmount: a.allowance, allowUnknownCharges: true } },
          });
          if (s.closed) return;
          await readStatus(st.editId, `Submitted one edit${r?.jobId ? ` (job ${short(r.jobId)})` : ''}${r?.replay ? ', replayed from the earlier request' : ''}.`).catch(refreshCatch);
        } catch (e) {
          if (s.closed) return;
          const out = submitOutcome(e);
          s.submitUnknown = out.kind === 'unknown';
          s.note = out.text;
        }
      });
    },
    /** Explicit local retry only: one request per click, never on open, poll or timer. */
    resume: () => {
      const st = s.status;
      if (!st || !view()?.canResume) return Promise.resolve(false);
      return run('resume', async () => {
        try {
          const next = await o.request<MaskedEditStatus>('resume', { projectId: o.take.projectId, editId: st.editId });
          if (s.closed) return;
          if (!statusMatchesTake(next, o.take)) { s.note = 'Resume returned a different take. Nothing changed here.'; return; }
          s.status = next; s.note = maskedEditView(next).message;
        } catch (e) {
          if (s.closed) return;
          if (!(e instanceof MaskedEditRequestError) || e.status === null) { s.note = 'Resume outcome UNKNOWN (no response). Resume is local only; refresh status.'; return; }
          await readStatus(st.editId, `${errText(e)}.`).catch(refreshCatch);
        }
      });
    },
    recordReview: () => {
      const st = s.status;
      if (!st || !view()?.canRecordReview || !st.candidateSha256) return Promise.resolve(false);
      return run('review', async () => {
        try {
          await o.request('review', { projectId: o.take.projectId, editId: st.editId, candidateSha256: st.candidateSha256, sourceSha256: st.sourceSha256, fingerprint: st.inputKey || st.quoteFingerprint, reviewedScope: true });
          if (!s.closed) await readStatus(st.editId).catch(refreshCatch);
        } catch (e) { if (!s.closed) s.note = errText(e); }
      });
    },
    /** Saves a child take only. The acceptance id is reused on retry so an unknown outcome cannot save twice. */
    accept: (expectedRevision: number) => {
      const st = s.status;
      if (!st || !view()?.canAccept) return Promise.resolve(false);
      const acceptanceId = acceptIds.get(st.editId) || uuid();
      acceptIds.set(st.editId, acceptanceId);
      return run('accept', async () => {
        try {
          await o.request('accept', { projectId: o.take.projectId, editId: st.editId, candidateSha256: st.candidateSha256, reviewId: st.review!.id, acceptanceId, expectedRevision });
          if (!s.closed) await readStatus(st.editId).catch(refreshCatch);
        } catch (e) {
          if (s.closed) return;
          if (!(e instanceof MaskedEditRequestError) || e.status === null || e.status >= 500) {
            s.acceptUnknown = true;
            s.note = 'Save outcome UNKNOWN. Refresh status before retrying; a retry reuses the same acceptance id, so it cannot save twice.';
          } else s.note = errText(e);
        }
      });
    },
    /** Leave the saved receipt untouched and author a new draft. */
    startNewDraft: () => { if (s.busy) return; s.status = null; s.note = ''; changed(); },
    close: () => { s.closed = true; },
  };
}

function mediaUrl(path: string | null | undefined) {
  if (!path) return '';
  return path.startsWith('/') ? path : `/api/director/${path}`;
}

type ReviewLane = 'original' | 'edited' | 'mask';

export async function openMaskedEdit(ctx: MaskedEditCtx, shotId: string, take: VideoTake) {
  document.getElementById('masked-edit-dialog')?.remove();
  const P = () => ctx.project();
  const shot = (): Shot | null => P().shots.find(s => s.id === shotId) || null;
  const asset = (): Asset | null => P().assets?.find(a => a.id === take.id) || null;
  const elig = maskedEditEligibility(asset() || { kind: 'workflow-result', mime: 'video/mp4', width: take.media.width!, height: take.media.height!, fps: take.media.fps!, frameCount: take.media.frames!, duration: take.media.duration! } as Asset);
  if (DEMO) {
    toast('Region editing needs the local app and an eligible generated take.');
    return;
  }
  if (!elig.ok) {
    toast(elig.reason + (elig.detail ? ` ${elig.detail}` : ''));
    return;
  }

  let mask = emptyMask();
  let history: FixedMask[] = [structuredClone(mask)];
  let histIdx = 0;
  let tool: 'rect' | 'brush' | 'erase' = 'rect';
  let brushSize = 28;
  let prompt = '';
  let seed = 42;
  let scopeChecked = false;
  let unknownAck = false;
  let allowance = 0.5;
  let crop: { x: number; y: number; w: number; h: number } | null = null;
  let reviewLane: ReviewLane = 'edited';

  const session = createMaskedEditSession({
    request: maskedEditRequest, storage: browserStorage(),
    take: { projectId: P().id, shotId, sourceAssetId: take.id, sourceSha256: asset()?.sha256 },
    onChange: () => draw(),
  });

  const title = h('h2', { id: 'masked-edit-title' });
  const status = h('p', { class: 'note tk-edit-status', role: 'status' });
  const body = h('div', { class: 'tk-edit-body' });
  const close = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close region edit' }, '✕');
  const dlg = h('dialog', { class: 'takes tk-edit', id: 'masked-edit-dialog', 'aria-labelledby': 'masked-edit-title' },
    h('div', { class: 'dialog-head' }, title, close),
    body, status);
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => {
    session.close();
    dlg.remove();
    ctx.focusReturn?.focus?.();
  });

  const say = (t: string) => { status.textContent = t; };
  const pushHist = () => { history = history.slice(0, histIdx + 1); history.push(structuredClone(mask)); histIdx = history.length - 1; if (history.length > 40) { history.shift(); histIdx--; } };
  const undo = () => { if (histIdx > 0) { histIdx--; mask = structuredClone(history[histIdx]!); draw(); } };
  const redo = () => { if (histIdx < history.length - 1) { histIdx++; mask = structuredClone(history[histIdx]!); draw(); } };

  const video = h('video', {
    class: 'tk-edit-video', src: asset() ? ctx.assetUrl(asset()!) : '', muted: true, playsinline: true, preload: 'auto',
    'aria-label': `Source ${take.label}`,
  }) as HTMLVideoElement;
  const overlay = h('canvas', { class: 'tk-edit-overlay', width: MASKED_EDIT_SIZE.width, height: MASKED_EDIT_SIZE.height, 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'tk-edit-stage' }, video, overlay);

  function paintOverlay() {
    const c = overlay.getContext('2d')!;
    c.clearRect(0, 0, overlay.width, overlay.height);
    c.fillStyle = 'rgba(20, 120, 200, 0.35)';
    if (mask.rect) { c.fillRect(mask.rect.x, mask.rect.y, mask.rect.w, mask.rect.h); c.strokeStyle = 'rgba(0,0,0,0.85)'; c.setLineDash([6, 4]); c.strokeRect(mask.rect.x, mask.rect.y, mask.rect.w, mask.rect.h); c.setLineDash([]); }
    for (const s of mask.strokes) {
      c.strokeStyle = s.tool === 'erase' ? 'rgba(0,0,0,1)' : 'rgba(20, 120, 200, 0.7)';
      c.lineWidth = s.size; c.lineCap = 'round'; c.lineJoin = 'round';
      if (s.tool === 'erase') c.globalCompositeOperation = 'destination-out';
      else c.globalCompositeOperation = 'source-over';
      c.beginPath();
      s.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
    if (crop) { c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2; c.setLineDash([4, 4]); c.strokeRect(crop.x, crop.y, crop.w, crop.h); c.setLineDash([]); }
  }

  function sourcePoint(ev: PointerEvent) {
    const r = overlay.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * MASKED_EDIT_SIZE.width;
    const y = ((ev.clientY - r.top) / r.height) * MASKED_EDIT_SIZE.height;
    return { x: Math.min(MASKED_EDIT_SIZE.width, Math.max(0, x)), y: Math.min(MASKED_EDIT_SIZE.height, Math.max(0, y)) };
  }

  const painting = () => !session.state.status && !session.state.busy;
  let drawing = false, rectStart: { x: number; y: number } | null = null, stroke: MaskStroke | null = null;
  overlay.onpointerdown = ev => {
    if (!painting()) return;
    overlay.setPointerCapture(ev.pointerId); drawing = true;
    const p = sourcePoint(ev);
    if (tool === 'rect') { rectStart = p; mask.rect = { x: p.x, y: p.y, w: 0, h: 0 }; }
    else {
      if (mask.strokes.length >= MAX_STROKES) { say('Stroke limit reached.'); return; }
      stroke = { tool: tool === 'erase' ? 'erase' : 'brush', size: brushSize, points: [p] };
      mask.strokes.push(stroke);
    }
    paintOverlay();
  };
  overlay.onpointermove = ev => {
    if (!drawing || !painting()) return;
    const p = sourcePoint(ev);
    if (tool === 'rect' && rectStart) {
      mask.rect = { x: Math.min(rectStart.x, p.x), y: Math.min(rectStart.y, p.y), w: Math.abs(p.x - rectStart.x), h: Math.abs(p.y - rectStart.y) };
    } else if (stroke && stroke.points.length < MAX_POINTS) stroke.points.push(p);
    paintOverlay();
  };
  overlay.onpointerup = () => {
    if (!drawing) return;
    drawing = false; rectStart = null; stroke = null; pushHist(); crop = null; draw();
  };
  overlay.onpointercancel = () => { drawing = false; rectStart = null; stroke = null; };

  async function saveDraft() {
    const cropped = cropAroundMask(mask);
    if (!cropped) { say('Paint what may change. The region stays fixed on screen.'); return; }
    if (!cropped.ok) { say(cropped.reason); crop = cropped.crop; paintOverlay(); return; }
    if (!prompt.trim()) { say('Describe the surface edit inside the region.'); return; }
    if (!scopeChecked) { say('Confirm you checked this region through the whole clip.'); return; }
    crop = cropped.crop;
    await session.prepare({ expectedRevision: P().revision, draftId: crypto.randomUUID(), mask, prompt, seed });
  }

  const fact = (k: string, v: string) => h('div', {}, h('dt', {}, k), h('dd', {}, v));

  function drawSaved() {
    const saved = session.saved();
    if (!saved.length) return null;
    return h('div', { class: 'tk-edit-saved', role: 'group', 'aria-label': 'Saved region edits for this take' },
      h('p', { class: 'note' }, `Saved region edits for this take (remembered by this browser only, last ${MAX_RECEIPT_POINTERS} across projects):`),
      ...saved.map(p => h('button', { type: 'button', class: 'btn sm', disabled: Boolean(session.state.busy), onclick: () => void session.load(p.editId) },
        `Open edit ${short(p.editId)} · ${new Date(p.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`)));
  }

  function drawPaint() {
    const tools = h('div', { class: 'tk-edit-tools', role: 'toolbar', 'aria-label': 'Mask tools' },
      ...(['rect', 'brush', 'erase'] as const).map(t => h('button', { type: 'button', class: `btn sm${tool === t ? ' on' : ''}`, 'aria-pressed': String(tool === t), onclick: () => { tool = t; draw(); } }, t === 'rect' ? 'Rectangle' : t === 'brush' ? 'Brush' : 'Erase')),
      h('label', { class: 'tk-edit-field' }, 'Brush', h('input', { type: 'range', min: 8, max: 96, value: brushSize, oninput: (ev: Event) => { brushSize = Number((ev.target as HTMLInputElement).value); } })),
      h('button', { type: 'button', class: 'btn sm', onclick: undo }, 'Undo'),
      h('button', { type: 'button', class: 'btn sm', onclick: redo }, 'Redo'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { mask = emptyMask(); pushHist(); crop = null; draw(); } }, 'Reset'));
    const rectFields = h('div', { class: 'tk-edit-rect', role: 'group', 'aria-label': 'Rectangle in source pixels' },
      ...(['x', 'y', 'w', 'h'] as const).map(k => {
        const val = mask.rect?.[k] ?? 0;
        return h('label', { class: 'tk-edit-field' }, k.toUpperCase(), h('input', {
          class: 'field sm', type: 'number', min: 0, max: k === 'w' || k === 'x' ? MASKED_EDIT_SIZE.width : MASKED_EDIT_SIZE.height, value: Math.round(val),
          onchange: (ev: Event) => {
            const n = Number((ev.target as HTMLInputElement).value);
            mask.rect = { x: mask.rect?.x ?? 0, y: mask.rect?.y ?? 0, w: mask.rect?.w ?? 0, h: mask.rect?.h ?? 0, [k]: n };
            pushHist(); crop = null; draw();
          },
        }));
      }));
    const promptEl = h('textarea', { class: 'field tk-edit-prompt', rows: 3, maxlength: 2500, placeholder: 'Change the dark coat to a red parka. Keep the pose.', value: prompt, oninput: (ev: Event) => { prompt = (ev.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement;
    const scope = h('label', { class: 'tk-check' }, h('input', { type: 'checkbox', checked: scopeChecked, onchange: (ev: Event) => { scopeChecked = (ev.target as HTMLInputElement).checked; } }), 'I checked this region through the whole clip.');
    const prepareBtn = h('button', { type: 'button', class: 'btn primary', disabled: Boolean(session.state.busy), onclick: () => void saveDraft() }, session.state.busy === 'prepare' ? 'Saving draft…' : 'Save draft & quote');
    body.replaceChildren(
      h('p', { class: 'note' }, 'Original is kept. This does not change your cut. Fixed on screen · same region in every frame.'),
      h('p', { class: 'note tk-edit-meta mono' }, `${take.id.slice(0, 8)} · ${take.model} · ${take.media.width}×${take.media.height} · ${take.media.fps} fps · ${take.media.frames} frames`),
      ...[drawSaved()].filter(Boolean) as HTMLElement[],
      stage,
      h('p', { class: 'note' }, 'Paint what may change. The region stays fixed on screen.'),
      tools, rectFields,
      h('label', { class: 'tk-edit-field tk-edit-prompt-label' }, 'Edit prompt', promptEl),
      h('p', { class: 'note' }, 'Everything inside the region may change. Faces, identity and exact colors are not guaranteed.'),
      scope,
      h('p', { class: 'note' }, 'Saving stores the mask, prompt and quote on the local server. Nothing is submitted.'),
      h('div', { class: 'tk-edit-acts' }, prepareBtn),
    );
    paintOverlay();
    say(session.state.note || 'Paint what may change. The region stays fixed on screen.');
  }

  function reviewStage(st: MaskedEditStatus, showCandidate: boolean) {
    const lanes: ReviewLane[] = showCandidate ? ['original', 'edited', 'mask'] : ['original', 'mask'];
    if (!lanes.includes(reviewLane)) reviewLane = 'original';
    const src = asset() ? ctx.assetUrl(asset()!) : '';
    const tabs = h('div', { class: 'tk-edit-lanes', role: 'group', 'aria-label': 'Review lanes' },
      ...lanes.map(lane => h('button', {
        type: 'button', class: `btn sm${reviewLane === lane ? ' on' : ''}`, 'aria-pressed': String(reviewLane === lane),
        onclick: () => { reviewLane = lane; draw(); },
      }, lane === 'original' ? 'Original' : lane === 'edited' ? 'Edited' : 'Mask')));
    const view = reviewLane === 'mask'
      ? h('img', { class: 'tk-edit-mask', src: mediaUrl(st.media?.mask), alt: 'Fixed mask: white may change, black is kept' })
      : h('video', {
        class: 'tk-edit-video', src: reviewLane === 'edited' ? mediaUrl(st.media?.candidate) : src,
        muted: true, playsinline: true, controls: true, preload: 'auto',
        'aria-label': reviewLane === 'edited' ? 'Edited candidate preview' : `Original ${take.label}`,
      });
    return [tabs, h('div', { class: 'tk-edit-stage tk-edit-review' }, view),
      reviewLane === 'mask' ? h('p', { class: 'note' }, 'White may change; black is kept. The same region applies to every frame.') : null];
  }

  function drawServer(st: MaskedEditStatus) {
    const v = session.view()!, busy = session.state.busy;
    const refresh = h('button', { type: 'button', class: 'btn', disabled: Boolean(busy), onclick: () => void session.refresh() }, busy === 'status' ? 'Refreshing…' : 'Refresh status');
    const other = h('button', { type: 'button', class: 'btn ghost', disabled: Boolean(busy), onclick: () => { crop = null; session.startNewDraft(); } }, 'New draft (keeps this one)');
    const quoteLine = Number.isFinite(Number(st.quote?.estimate))
      ? `Estimated $${Number(st.quote!.estimate).toFixed(2)} · reserves $${Number(st.quote!.reservationRequiredUsd ?? 0).toFixed(2)}` : 'No reliable estimate saved';
    const summary = h('dl', { class: 'tk-facts tk-edit-summary' },
      fact('Prompt', st.prompt ?? 'Not shown by this server'),
      fact('Seed', st.seed == null ? '—' : String(st.seed)),
      fact('Crop', st.cropRect ? `${st.cropRect.w}×${st.cropRect.h} at (${st.cropRect.x},${st.cropRect.y})` : '—'),
      fact('Quote', quoteLine));
    const parts: (HTMLElement | null)[] = [
      h('p', { class: 'note tk-edit-meta mono' }, `${take.id.slice(0, 8)} · edit ${short(st.editId)} · ${st.state}${st.jobId ? ` · job ${short(st.jobId)}` : ''}`),
      h('p', { class: `note tk-edit-mode tk-edit-mode-${v.mode}` }, v.message),
    ];
    const acts: (HTMLElement | null)[] = [];
    if (v.mode === 'prepared') {
      parts.push(summary, ...reviewStage(st, false),
        h('p', { class: 'note' }, 'This saved draft is read-only. To change the mask or prompt, start a new draft; this one is kept.'),
        h('p', { class: 'note' }, st.cropRect ? `Only this ${st.cropRect.w}×${st.cropRect.h} crop and its mask are uploaded to Comfy Cloud.` : ''),
        h('label', { class: 'tk-check' }, h('input', { type: 'checkbox', checked: scopeChecked, onchange: (ev: Event) => { scopeChecked = (ev.target as HTMLInputElement).checked; draw(); } }), 'I checked this region through the whole clip.'),
        h('label', { class: 'tk-edit-field' }, 'Run allowance (USD)', h('input', { class: 'field sm', type: 'number', min: 0, step: 0.01, value: allowance, onchange: (ev: Event) => { allowance = Number((ev.target as HTMLInputElement).value); draw(); } })),
        h('label', { class: 'tk-check' }, h('input', { type: 'checkbox', checked: unknownAck, onchange: (ev: Event) => { unknownAck = (ev.target as HTMLInputElement).checked; draw(); } }), 'I understand Cloud runtime charges may exceed this estimate; this allowance is not a provider billing cap.'));
      const reserve = Number(st.quote?.reservationRequiredUsd);
      const ready = v.canGenerate && scopeChecked && unknownAck && Number.isFinite(reserve) && allowance >= reserve;
      acts.push(h('button', { type: 'button', class: 'btn primary', disabled: !ready, onclick: () => void session.generate({ allowance, scopeChecked, unknownAck }) },
        busy === 'generate' ? 'Submitting…' : `Generate edit · ${quoteLine.toLowerCase()}`));
    } else {
      parts.push(summary, ...reviewStage(st, v.showCandidate));
      if (v.showCandidate && st.preservation?.outsideExact) {
        parts.push(h('p', { class: 'note' }, 'Outside the mask, the composite matched the original in the pre-encode RGB check. The preview MP4 is lossy-encoded, so it is not a pixel-exact view.'));
      }
      if (v.canResume || v.mode === 'resume' || v.mode === 'preview-failed') {
        acts.push(h('button', { type: 'button', class: 'btn', disabled: !v.canResume, onclick: () => void session.resume() },
          busy === 'resume' ? 'Working locally…' : v.mode === 'preview-failed' ? 'Retry preview (local)' : 'Resume local composite'));
      }
      if (v.mode === 'review') {
        acts.push(h('button', { type: 'button', class: 'btn', disabled: !v.canRecordReview, onclick: () => void session.recordReview() },
          st.review?.id ? 'Review recorded' : 'I reviewed Original, Edited and Mask'));
        acts.push(h('button', { type: 'button', class: 'btn primary', disabled: !v.canAccept, onclick: () => void session.accept(P().revision) },
          busy === 'accept' ? 'Saving…' : 'Save as new take'));
      }
    }
    acts.push(refresh, other);
    body.replaceChildren(...parts.filter(Boolean) as HTMLElement[], h('div', { class: 'tk-edit-acts' }, ...acts.filter(Boolean) as HTMLElement[]));
    say(session.state.note || v.message);
  }

  function draw() {
    const s = shot(); if (!s) { dlg.close(); return; }
    const no = String(P().shots.indexOf(s) + 1).padStart(2, '0');
    title.textContent = `Edit region · Shot ${no} · ${take.label}`;
    const st = session.state.status;
    if (st) drawServer(st); else drawPaint();
  }

  document.body.append(dlg);
  draw();
  dlg.showModal();
}
