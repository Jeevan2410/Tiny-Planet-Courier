/**
 * glTF asset pipeline.
 *
 * Takes authored .glb / .gltf files out of `assets/source/` and writes
 * web-ready versions into `public/models/`, then copies the matching Draco
 * decoder into `public/draco/` so the client can read them.
 *
 * This is the piece that was missing when the game was first built: everything
 * in it is generated in code precisely because there was no way to author and
 * compress real art. With this in place, dropping a Blender export into
 * `assets/source/` is all it takes -- `src/player/GltfRig.ts` will pick it up.
 *
 * Usage:  npm run assets
 *         npm run assets -- --no-draco      (skip mesh compression)
 *         npm run assets -- --max-texture=512
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  draco,
  prune,
  resample,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(root, 'assets', 'source');
const OUT_DIR = path.join(root, 'public', 'models');
const DRACO_OUT = path.join(root, 'public', 'draco');
const DRACO_SRC = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');

const args = process.argv.slice(2);
const useDraco = !args.includes('--no-draco');
const maxTexture = Number(args.find((a) => a.startsWith('--max-texture='))?.split('=')[1] ?? 1024);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

async function main() {
  if (!existsSync(SOURCE_DIR)) {
    console.log(`No source directory at ${path.relative(root, SOURCE_DIR)} -- nothing to do.`);
    console.log('Drop a .glb export in there and run this again.');
    return;
  }

  const entries = (await readdir(SOURCE_DIR)).filter((f) => /\.(glb|gltf)$/i.test(f));
  if (entries.length === 0) {
    console.log('No .glb or .gltf files found in assets/source.');
    return;
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

  await mkdir(OUT_DIR, { recursive: true });

  let totalBefore = 0;
  let totalAfter = 0;

  for (const name of entries) {
    const src = path.join(SOURCE_DIR, name);
    const out = path.join(OUT_DIR, name.replace(/\.gltf$/i, '.glb'));
    const before = (await stat(src)).size;

    const document = await io.read(src);

    const transforms = [
      // Merge identical accessors/materials that exporters duplicate.
      dedup(),
      // Index the geometry. Draco requires indexed meshes, and it shrinks
      // vertex counts on hard-edged low-poly models considerably.
      weld(),
      // Drop redundant animation keyframes -- exporters bake every frame.
      resample(),
      // Remove anything nothing references any more.
      prune(),
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [maxTexture, maxTexture],
      }),
    ];

    // Draco last: once geometry is compressed the other transforms cannot read it.
    if (useDraco) {
      transforms.push(draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10 }));
    }

    await document.transform(...transforms);
    await io.write(out, document);

    const after = (await stat(out)).size;
    totalBefore += before;
    totalAfter += after;

    const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    console.log(`  ${name.padEnd(28)} ${kb(before).padStart(10)} -> ${kb(after).padStart(10)}  (-${saved}%)`);
  }

  // The client needs a decoder that matches the encoder version, so ship the
  // one that came with our copy of three rather than a CDN build.
  if (useDraco && existsSync(DRACO_SRC)) {
    await mkdir(DRACO_OUT, { recursive: true });
    await cp(DRACO_SRC, DRACO_OUT, { recursive: true });
    console.log(`\n  Draco decoder copied to ${path.relative(root, DRACO_OUT)}`);
  }

  const saved = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
  console.log(`\n  ${entries.length} file(s): ${kb(totalBefore)} -> ${kb(totalAfter)} (-${saved}%)`);
}

main().catch((error) => {
  console.error('[assets] failed:', error);
  process.exitCode = 1;
});
