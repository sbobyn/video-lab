#!/usr/bin/env node
// Provenance for the library-built starter blockouts (STE-3089).
//   node scripts/blender/library-provenance.mjs   # checks the sidecar against the recipe, GLBs and manifest; exit 1 on drift
// The sidecar (library-blockouts.provenance.json) records the recipe SHA-256, each library output's SHA-256 and bytes, and
// the producer identity. public/models/blockouts/manifest.json keeps its consumer schema ({ shape, triangles, bytes }).
// requireProducer() is the guard library-blockouts.mjs runs before any child process or write.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RECIPE = 'scripts/blender/library-blockouts.json';
export const OUT = 'public/models/blockouts';
export const SIDECAR = 'scripts/blender/library-blockouts.provenance.json';
// The producer command this script runs: `node src/cli/main.ts bake-blockouts --recipe <file> --out <dir>`, which writes
// <id>.glb per recipe id and prints { id: { shape, triangles, bytes } }. Checked statically in the pinned commit's source.
export const CONTRACT = { cli: 'src/cli/main.ts', command: 'bake-blockouts', markers: ["case 'bake-blockouts'", 'opt.recipe', 'opt.out'] };
// Producer inputs that must be clean (tracked and untracked) at the pinned commit.
export const PRODUCER_INPUTS = ['assets', 'src', 'packages', 'package.json', 'pnpm-lock.yaml'];
const MIN_NODE = [23, 6]; // runs TypeScript sources directly (type stripping)

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** Recipe hash and per-id output hashes, read from disk. */
export async function describeLibrary(root, dir = join(root, OUT)) {
  const recipeBuf = await readFile(join(root, RECIPE));
  const ids = Object.keys(JSON.parse(recipeBuf.toString('utf8')));
  const outputs = {};
  for (const id of ids) {
    const glb = await readFile(join(dir, `${id}.glb`));
    outputs[id] = { sha256: sha256(glb), bytes: glb.length };
  }
  return { recipe: { path: RECIPE, sha256: sha256(recipeBuf), ids: ids.length }, outputs };
}

/** Differences between the sidecar and the files on disk; [] when they agree. */
export async function verifyProvenance(root) {
  const problems = [];
  const sidecar = JSON.parse(await readFile(join(root, SIDECAR), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, OUT, 'manifest.json'), 'utf8'));
  let now;
  try { now = await describeLibrary(root); } catch (e) { return [`cannot read the library recipe or outputs: ${e.message}`]; }
  if (sidecar.recipe?.sha256 !== now.recipe.sha256) problems.push(`recipe ${RECIPE} sha256 ${now.recipe.sha256} != sidecar ${sidecar.recipe?.sha256}`);
  const want = Object.keys(sidecar.outputs ?? {}).sort(), have = Object.keys(now.outputs).sort();
  if (want.join() !== have.join()) problems.push(`recipe ids [${have}] != sidecar ids [${want}]`);
  for (const [id, o] of Object.entries(now.outputs)) {
    const s = sidecar.outputs?.[id];
    if (s && s.sha256 !== o.sha256) problems.push(`${id}.glb sha256 ${o.sha256} != sidecar ${s.sha256}`);
    if (manifest[id]?.bytes !== o.bytes) problems.push(`${id}.glb is ${o.bytes} bytes; manifest.json says ${manifest[id]?.bytes}`);
  }
  return problems;
}

/**
 * Check the producer checkout before anything runs or is written. `git(args)` runs git in the checkout and returns stdout.
 * Throws a message naming what to fix; returns the identity to persist after a bake.
 */
export function requireProducer({ lib, pin, git, node = process.version }) {
  if (!lib) throw Error('Set BERET_PARTS to the producer checkout (github.com/sbobyn/beret-parts, now Model Lab).');
  if (!/^[0-9a-f]{40}$/.test(pin ?? '')) throw Error('Set BERET_PARTS_COMMIT to the full 40-character producer commit to bake from. Nothing was baked or written.');
  const [maj, min] = node.replace(/^v/, '').split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) throw Error(`Node ${node} cannot run the producer's TypeScript CLI; use Node ≥ ${MIN_NODE.join('.')}.`);
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== pin) throw Error(`Producer checkout is at ${head}, not the pinned ${pin}. Check out the pinned commit there yourself; this script does not switch it.`);
  const dirty = git(['status', '--porcelain', '--', ...PRODUCER_INPUTS]).trimEnd();
  if (dirty) throw Error(`Producer inputs are not clean at ${pin}:\n${dirty}`);
  const cli = git(['show', `${pin}:${CONTRACT.cli}`]);
  const missing = CONTRACT.markers.filter(m => !cli.includes(m));
  if (missing.length) throw Error(`Producer ${pin} does not provide the expected \`${CONTRACT.command}\` contract in ${CONTRACT.cli} (missing ${missing.join(', ')}). Reconcile the consumer contract (STE-3091) before baking.`);
  const pkg = JSON.parse(git(['show', `${pin}:package.json`]));
  let nvmrc = null;
  try { nvmrc = git(['show', `${pin}:.nvmrc`]).trim(); } catch {}
  let recipe = null;
  try { recipe = sha256(Buffer.from(git(['show', `${pin}:recipes/previs-starter-blockouts.json`]), 'utf8')); } catch {}
  return {
    repository: 'github.com/sbobyn/beret-parts', commit: pin, package: { name: pkg.name, version: pkg.version },
    command: `node ${CONTRACT.cli} ${CONTRACT.command}`, node, producerNvmrc: nvmrc, producerRecipeSha256: recipe,
  };
}

const main = async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const problems = await verifyProvenance(root);
  if (problems.length) { console.error(`library provenance: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exitCode = 1; }
  else console.log(`library provenance: recipe and ${Object.keys(JSON.parse(await readFile(join(root, SIDECAR), 'utf8')).outputs).length} outputs match ${SIDECAR}`);
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
