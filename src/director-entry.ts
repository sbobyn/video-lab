// director.html's entry: loads the workspace module and, if it fails to load or throws while starting (before boot() and its
// project-load catch run, e.g. when the 3D view can't be created), shows a recovery view instead of a blank page.
// Self-contained on purpose: the module that failed may be one this would otherwise import. Starts the workspace once;
// every action leaves or reloads the page, so a partly started workspace is never started again in place.

const GRAPHICS = /webgl|gpu|graphics context/i;

/** The failure view: what happened, the likely cause only when the error names graphics, and ways out. */
export function showStartupFailure(error: unknown, demo = Boolean(import.meta.env.VITE_DEMO)) {
  console.error('video-lab: the Director workspace failed to start', error); // the original error, for the console and Report a problem
  const message = error instanceof Error ? error.message : String(error ?? '');
  const graphics = GRAPHICS.test(message);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text) node.textContent = text;
    return node;
  };
  const title = el('h1', { id: 'startup-failure-title', tabindex: '-1', style: 'font-size:20px;margin:0 0 8px' }, 'The workspace couldn’t start');
  const box = el('div', { class: 'empty-state', role: 'alert', 'aria-labelledby': 'startup-failure-title', style: 'margin:80px auto;max-width:460px;text-align:left' });
  box.append(title,
    el('p', {}, graphics
      ? 'The 3D view couldn’t be created. Your browser or device may have graphics (WebGL) turned off or unavailable. Check that hardware acceleration is on, close other 3D tabs, then reload.'
      : 'Something went wrong while the workspace was loading, before this project opened. Reloading often helps.'),
    el('p', { class: 'muted', style: 'font-size:13px' }, demo
      ? 'Details are in the browser console.'
      : 'Details are in the browser console. If it keeps happening, check Setup or report the problem with those details.'));
  const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' });
  const reload = el('button', { class: 'btn primary', type: 'button' }, 'Reload');
  reload.addEventListener('click', () => location.reload());
  actions.append(reload, el('a', { class: 'btn', href: '/' }, 'Back to projects'));
  if (!demo) actions.append(el('a', { class: 'btn', href: '/setup.html' }, 'Check setup'));
  box.append(actions);
  (document.getElementById('app') ?? document.body).replaceChildren(box);
  title.focus();
}

import('./director').catch(e => showStartupFailure(e));
