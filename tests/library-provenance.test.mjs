// Library blockout provenance (STE-3089): the checked-in sidecar matches the recipe and bundled GLBs, and a library bake
// refuses to run or write without a clean, pinned producer with the expected command. No real producer or bake runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, RECIPE, SIDECAR, sha256, verifyProvenance } from '../scripts/blender/library-provenance.mjs';
import { bakeLibrary } from '../scripts/blender/library-blockouts.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PIN = 'a'.repeat(40);
const CLI = "switch (cmd) { case 'bake-blockouts': { read(opt.recipe); write(opt.out); } }";

test('the checked-in sidecar matches the recipe and every library GLB, and keeps the historical producer unknown', async () => {
  assert.deepEqual(await verifyProvenance(repo), []);
  const sidecar = JSON.parse(await readFile(join(repo, SIDECAR), 'utf8'));
  const recipeIds = Object.keys(JSON.parse(await readFile(join(repo, RECIPE), 'utf8')));
  const manifestIds = Object.keys(JSON.parse(await readFile(join(repo, OUT, 'manifest.json'), 'utf8')));
  assert.equal(sidecar.producer.status, 'unknown');
  assert.equal(sidecar.producer.commit, undefined);
  assert.deepEqual(sidecar.producer.evidence.flatMap(e => e.ids).sort(), [...recipeIds].sort());
  assert.deepEqual([...recipeIds, ...sidecar.producer.notLibrary].sort(), [...manifestIds].sort());
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lib-prov-'));
  await mkdir(join(root, OUT), { recursive: true });
  await mkdir(join(root, 'scripts/blender'), { recursive: true });
  await writeFile(join(root, RECIPE), JSON.stringify({ a: { family: 'f', shape: 'box' }, b: { family: 'f', shape: 'sphere' } }));
  await writeFile(join(root, OUT, 'a.glb'), 'old-a');
  await writeFile(join(root, OUT, 'b.glb'), 'old-b');
  await writeFile(join(root, OUT, 'keep.glb'), 'blender');
  await writeFile(join(root, OUT, 'manifest.json'), JSON.stringify({ a: { shape: 'box', triangles: 1, bytes: 5 }, b: { shape: 'sphere', triangles: 1, bytes: 5 }, keep: { shape: 'bird', triangles: 9, bytes: 7 } }));
  return root;
}
const snapshot = async root => Promise.all(['a.glb', 'b.glb', 'keep.glb', 'manifest.json'].map(f => readFile(join(root, OUT, f), 'utf8')));

// A fake child runner: answers git queries for a producer checkout and fakes the bake by writing tiny GLBs into --out.
function runner({ head = PIN, dirty = '', cli = CLI, files = { a: 'new-aa', b: 'new-bbb' }, report } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') {
      if (args[0] === 'rev-parse') return head + '\n';
      if (args[0] === 'status') return dirty;
      if (args[1] === `${PIN}:src/cli/main.ts`) return cli;
      if (args[1] === `${PIN}:package.json`) return JSON.stringify({ name: 'beret-parts', version: '0.0.1' });
      if (args[1] === `${PIN}:.nvmrc`) return '26.13.0\n';
      throw Error(`no such path: ${args[1]}`);
    }
    if (args[0] === 'scripts/blender/lint-blockouts.mjs') return '';
    assert.deepEqual(args.slice(0, 3), ['src/cli/main.ts', 'bake-blockouts', '--recipe']);
    const out = args[args.indexOf('--out') + 1];
    const result = {};
    for (const [id, body] of Object.entries(files)) {
      writeFileSync(join(out, `${id}.glb`), body);
      result[id] = { shape: id === 'a' ? 'box' : 'sphere', triangles: 2, bytes: report?.[id] ?? body.length };
    }
    return JSON.stringify(result);
  };
  return { exec, calls };
}
const bakes = calls => calls.filter(c => c[0] !== 'git');

test('a library bake refuses before any child bake or write when the pin, Node, checkout or command contract is wrong', async () => {
  const root = await fixture();
  const before = await snapshot(root);
  const cases = [
    [{ lib: undefined }, {}, /Set BERET_PARTS/],
    [{ pin: undefined }, {}, /BERET_PARTS_COMMIT.*full 40-character/],
    [{ pin: 'abc1234' }, {}, /full 40-character/],
    [{ node: 'v22.12.0' }, {}, /Node ≥ 23\.6/],
    [{}, { head: 'b'.repeat(40) }, /is at b{40}, not the pinned a{40}/],
    [{}, { dirty: ' M assets/car/asset.ts' }, /not clean.*\n M assets\/car\/asset\.ts/],
    [{}, { cli: "case 'export': {}" }, /does not provide the expected `bake-blockouts` contract.*STE-3091/],
  ];
  try {
    for (const [opts, fake, message] of cases) {
      const { exec, calls } = runner(fake);
      await assert.rejects(bakeLibrary({ root, lib: '/producer', pin: PIN, node: 'v26.13.0', exec, log: () => {}, ...opts }), message);
      assert.deepEqual(bakes(calls), [], `${message}: no bake or lint ran`);
    }
    assert.deepEqual(await snapshot(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a bake whose files disagree with the producer report, or misses an id, writes nothing', async () => {
  const root = await fixture();
  const before = await snapshot(root);
  try {
    for (const fake of [{ report: { a: 99 } }, { files: { a: 'only-a' } }]) {
      const { exec } = runner(fake);
      await assert.rejects(bakeLibrary({ root, lib: '/producer', pin: PIN, node: 'v26.13.0', exec, log: () => {} }), /Nothing was written/);
    }
    assert.deepEqual(await snapshot(root), before);
    await assert.rejects(readFile(join(root, SIDECAR)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pinned bake copies outputs, keeps the manifest schema and other ids, and persists producer identity and hashes', async () => {
  const root = await fixture();
  try {
    const { exec, calls } = runner();
    const sidecar = await bakeLibrary({ root, lib: '/producer', pin: PIN, node: 'v26.13.0', exec, log: () => {} });
    const [a, b, keep, manifest] = await snapshot(root);
    assert.deepEqual([a, b, keep], ['new-aa', 'new-bbb', 'blender']);
    assert.deepEqual(JSON.parse(manifest), { a: { shape: 'box', triangles: 2, bytes: 6 }, b: { shape: 'sphere', triangles: 2, bytes: 7 }, keep: { shape: 'bird', triangles: 9, bytes: 7 } });
    assert.deepEqual(JSON.parse(await readFile(join(root, SIDECAR), 'utf8')), sidecar);
    assert.equal(sidecar.recipe.sha256, sha256(await readFile(join(root, RECIPE))));
    assert.deepEqual(sidecar.outputs, { a: { sha256: sha256('new-aa'), bytes: 6 }, b: { sha256: sha256('new-bbb'), bytes: 7 } });
    assert.deepEqual(sidecar.producer, { status: 'baked', repository: 'github.com/sbobyn/beret-parts', commit: PIN, package: { name: 'beret-parts', version: '0.0.1' }, command: 'node src/cli/main.ts bake-blockouts', node: 'v26.13.0', producerNvmrc: '26.13.0', producerRecipeSha256: null });
    // The producer wrote into a temporary folder, never into the repo, and the lint ran after.
    const bake = bakes(calls)[0];
    assert.ok(!bake[bake.indexOf('--out') + 1].startsWith(root));
    assert.deepEqual(bakes(calls)[1].slice(1), ['scripts/blender/lint-blockouts.mjs']);
    assert.deepEqual(await verifyProvenance(root), []);
    // The verifier checks recorded sizes as well as content hashes.
    const stale = structuredClone(sidecar); stale.outputs.b.bytes++;
    await writeFile(join(root, SIDECAR), JSON.stringify(stale));
    assert.match((await verifyProvenance(root)).join('\n'), /b\.glb is 7 bytes; sidecar says 8/);
    await writeFile(join(root, SIDECAR), JSON.stringify(sidecar));
    // The verifier catches a changed output.
    await writeFile(join(root, OUT, 'b.glb'), 'new-bbX');
    assert.match((await verifyProvenance(root)).join('\n'), /b\.glb sha256 .* != sidecar/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
