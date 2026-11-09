#!/usr/bin/env node
// Rebuild the starter blockouts that come from the beret-parts (now Model Lab) parametric library (no Blender needed).
//   BERET_PARTS=/path/to/beret-parts BERET_PARTS_COMMIT=<full 40-char sha> node scripts/blender/library-blockouts.mjs
// Bakes every id in scripts/blender/library-blockouts.json (family, preset/params, seed, video-lab shape, minScale) into
// public/models/blockouts, updates those manifest entries, writes library-blockouts.provenance.json, then runs the
// coplanar lint. People, animals and terrain stay on generate-blockouts.py, which skips the ids listed here.
// Before invoking the producer or writing outputs it requires the checkout to be clean at the pinned commit with the expected command
// (library-provenance.mjs). The producer bakes into a temporary folder; nothing in this repo changes unless every id
// comes back with the bytes it reported.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTRACT, OUT, RECIPE, SIDECAR, requireProducer, sha256 } from './library-provenance.mjs';

export async function bakeLibrary({ root, lib, pin, exec = execFileSync, node = process.version, log = console.log }) {
  const producer = requireProducer({ lib, pin, node, git: args => exec('git', args, { cwd: lib, encoding: 'utf8' }) });
  const recipeBuf = await readFile(join(root, RECIPE));
  const recipe = JSON.parse(recipeBuf.toString('utf8'));
  const tmp = await mkdtemp(join(tmpdir(), 'library-blockouts-'));
  try {
    const baked = JSON.parse(exec(process.execPath, [CONTRACT.cli, CONTRACT.command, '--recipe', join(root, RECIPE), '--out', tmp], { cwd: lib, encoding: 'utf8' }));
    const ids = Object.keys(recipe);
    if (Object.keys(baked).sort().join() !== [...ids].sort().join()) throw Error(`Producer returned ids [${Object.keys(baked)}], recipe has [${ids}]. Nothing was written.`);
    const outputs = {};
    for (const id of ids) {
      const glb = await readFile(join(tmp, `${id}.glb`));
      if (glb.length !== baked[id].bytes) throw Error(`${id}.glb is ${glb.length} bytes; the producer reported ${baked[id].bytes}. Nothing was written.`);
      outputs[id] = { sha256: sha256(glb), bytes: glb.length };
    }
    const out = join(root, OUT), manifestPath = join(out, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const id of ids) {
      await copyFile(join(tmp, `${id}.glb`), join(out, `${id}.glb`));
      manifest[id] = { shape: baked[id].shape, triangles: baked[id].triangles, bytes: baked[id].bytes };
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const sidecar = { schema: 1, recipe: { path: RECIPE, sha256: sha256(recipeBuf), ids: ids.length }, producer: { status: 'baked', ...producer }, outputs };
    await writeFile(join(root, SIDECAR), JSON.stringify(sidecar, null, 2) + '\n');
    log(`library blockouts: ${ids.length} baked from ${producer.package.name} ${producer.commit} on Node ${node}`);
    exec(process.execPath, ['scripts/blender/lint-blockouts.mjs'], { cwd: root, stdio: 'inherit' });
    return sidecar;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bakeLibrary({ root: resolve(fileURLToPath(new URL('../..', import.meta.url))), lib: process.env.BERET_PARTS, pin: process.env.BERET_PARTS_COMMIT });
}
