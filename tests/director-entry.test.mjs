import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// director.html → src/director-entry.ts → src/director.ts. A failure while the workspace module loads or initializes
// (before boot() and its project-load catch) shows a recovery view; it never starts the workspace twice.
const source = await readFile(new URL('../src/director-entry.ts', import.meta.url), 'utf8');

async function load(director, { demo = false } = {}) {
  const js = ts.transpileModule(source.replace('import.meta.env.VITE_DEMO', JSON.stringify(demo ? '1' : '')), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const node = tag => ({ tag, attrs: {}, children: [], listeners: {}, textContent: '', focused: false,
    setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() { this.focused = true; } });
  const app = node('div'); app.children.push(node('header'));
  const errors = [], requires = [];
  let reloads = 0;
  runInNewContext(js, {
    exports: {}, Promise, Error, Object, String, Boolean,
    require: name => { requires.push(name); return director(); },
    document: { createElement: node, getElementById: id => id === 'app' ? app : null, body: node('body') },
    location: { reload: () => { reloads++; } },
    console: { error: (...a) => errors.push(a) },
  });
  await new Promise(r => setTimeout(r, 0));
  const all = n => [n, ...n.children.flatMap(all)];
  return { app, errors, requires, reloads: () => reloads, find: tag => all(app).filter(n => n.tag === tag) };
}

test('normal load: the workspace module is imported once and the page is left alone', async () => {
  const r = await load(() => ({}));
  assert.deepEqual(r.requires, ['./director']);
  assert.equal(r.app.children[0].tag, 'header');
  assert.equal(r.errors.length, 0);
});

test('graphics failure at initialization: accessible recovery view, original error logged, no retry', async () => {
  const err = new Error('Error creating WebGL context.');
  const r = await load(() => { throw err; });
  assert.deepEqual(r.requires, ['./director'], 'imported once, not retried');
  assert.equal(r.reloads(), 0, 'no automatic reload loop');
  assert.equal(r.errors[0][1], err, 'the original error reaches the console');
  const [box] = r.app.children;
  assert.equal(box.attrs.role, 'alert');
  const [title] = r.find('h1');
  assert.equal(box.attrs['aria-labelledby'], title.attrs.id);
  assert.ok(title.focused, 'focus moves to the heading');
  assert.match(r.find('p')[0].textContent, /WebGL/);
  assert.doesNotMatch(JSON.stringify(r.find('p').map(p => p.textContent)), /creating WebGL context/, 'the raw message stays in the console');
  const [reload] = r.find('button');
  assert.equal(reload.textContent, 'Reload');
  assert.deepEqual(r.find('a').map(a => [a.textContent, a.attrs.href]), [['Back to projects', '/'], ['Check setup', '/setup.html']]);
  reload.listeners.click();
  assert.equal(r.reloads(), 1, 'reload only when asked; it unloads the failed page');
});

test('other initialization failures are not labelled as graphics problems', async () => {
  const r = await load(() => { throw new TypeError("Cannot read properties of null (reading 'after')"); });
  const copy = r.find('p').map(p => p.textContent).join(' ');
  assert.doesNotMatch(copy, /WebGL|graphics/i);
  assert.match(copy, /before this project opened/);
  assert.doesNotMatch(copy, /Cannot read properties/);
});

test('demo: no Setup link (the static demo has no server checks)', async () => {
  const r = await load(() => { throw new Error('x'); }, { demo: true });
  assert.deepEqual(r.find('a').map(a => a.attrs.href), ['/']);
});

test('director.html loads the entry; boot() keeps its own project-load error view', async () => {
  assert.match(await readFile(new URL('../director.html', import.meta.url), 'utf8'), /<script type="module" src="\/src\/director-entry\.ts"><\/script>/);
  const ui = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
  assert.match(ui, /\} catch \(e\) \{\n    app\.replaceChildren\(h\('div', \{ class: 'empty-state'.*'Back to projects'\)\)\);\n  \}\n\}\nvoid boot\(\);\n$/);
});
