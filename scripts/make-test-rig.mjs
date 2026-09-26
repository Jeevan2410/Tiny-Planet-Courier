/**
 * Generates a small node-animated courier rig as a .glb, into `assets/source/`.
 *
 * This exists so the asset pipeline and the GLB loader are exercised by real
 * data rather than shipped as untested code. It is a stand-in, not art: a
 * Blender export dropped into the same folder replaces it and takes the same
 * path through `npm run assets`.
 *
 * The rig is deliberately NODE-animated rather than skinned, because that is
 * what this game's rig actually is -- a hierarchy of joints with boxes hung off
 * them. three's AnimationMixer drives either kind identically, so a skinned
 * export works just as well.
 *
 * Usage:  npm run assets:test-rig
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'assets', 'source', 'courier.glb');

/** Unit box centred on X/Z, resting on y = 0, sized (w, h, d). */
function boxData(w, h, d) {
  const x = w / 2;
  const z = d / 2;
  const y = h;
  // Six faces, four verts each, so normals stay hard.
  const faces = [
    { n: [0, 0, 1], v: [[-x, 0, z], [x, 0, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, 0, -z], [-x, 0, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, 0, z], [x, 0, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, 0, -z], [-x, 0, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]] },
  ];

  const position = [];
  const normal = [];
  const index = [];
  faces.forEach((face, f) => {
    for (const vertex of face.v) {
      position.push(...vertex);
      normal.push(...face.n);
    }
    const o = f * 4;
    index.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });

  return {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    index: new Uint16Array(index),
  };
}

async function main() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('courier');

  const material = (name, [r, g, b]) =>
    doc
      .createMaterial(name)
      .setBaseColorFactor([r, g, b, 1])
      .setRoughnessFactor(0.9)
      .setMetallicFactor(0);

  const outfit = material('outfit', [0.25, 0.5, 0.84]);
  const skin = material('skin', [0.95, 0.79, 0.63]);
  const boot = material('boot', [0.42, 0.27, 0.18]);

  /** A box mesh hung under `parent`, offset by `translation`. */
  const part = (name, parent, [w, h, d], translation, mat, anchorTop = false) => {
    const data = boxData(w, h, d);
    const prim = doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setArray(data.position).setBuffer(buffer),
      )
      .setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setArray(data.normal).setBuffer(buffer),
      )
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(data.index).setBuffer(buffer))
      .setMaterial(mat);

    // Limbs hang downward from their joint, so shift the box below the origin.
    if (anchorTop) {
      const pos = prim.getAttribute('POSITION');
      const array = pos.getArray().slice();
      for (let i = 1; i < array.length; i += 3) array[i] -= h;
      pos.setArray(array);
    }

    const node = doc
      .createNode(name)
      .setMesh(doc.createMesh(name).addPrimitive(prim))
      .setTranslation(translation);
    parent.addChild(node);
    return node;
  };

  const root3d = doc.createNode('root');
  scene.addChild(root3d);
  const hips = doc.createNode('hips').setTranslation([0, 0.66, 0]);
  root3d.addChild(hips);

  part('torso', hips, [0.46, 0.56, 0.3], [0, 0, 0], outfit);
  const head = part('head', hips, [0.36, 0.36, 0.34], [0, 0.6, 0], skin);
  const armL = part('armL', hips, [0.13, 0.5, 0.13], [0.245, 0.47, 0], outfit, true);
  const armR = part('armR', hips, [0.13, 0.5, 0.13], [-0.245, 0.47, 0], outfit, true);
  const legL = part('legL', hips, [0.16, 0.62, 0.18], [0.115, 0, 0], boot, true);
  const legR = part('legR', hips, [0.16, 0.62, 0.18], [-0.115, 0, 0], boot, true);

  // ---- animation clips -----------------------------------------------------
  // Quaternions for a pitch about local X, which is how a limb swings.
  const pitch = (angle) => {
    const h = angle / 2;
    return [Math.sin(h), 0, 0, Math.cos(h)];
  };

  const clip = (name, seconds, tracks) => {
    const animation = doc.createAnimation(name);
    for (const [node, keys] of tracks) {
      const times = new Float32Array(keys.map((k) => k[0]));
      const values = new Float32Array(keys.flatMap((k) => pitch(k[1])));
      const sampler = doc
        .createAnimationSampler()
        .setInterpolation('LINEAR')
        .setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType('VEC4').setArray(values).setBuffer(buffer));
      animation.addSampler(sampler);
      animation.addChannel(
        doc.createAnimationChannel().setTargetNode(node).setTargetPath('rotation').setSampler(sampler),
      );
    }
    return animation;
  };

  const swing = (amp) => [
    [0, 0],
    [0.25, amp],
    [0.5, 0],
    [0.75, -amp],
    [1.0, 0],
  ];
  const swingOpposite = (amp) => swing(amp).map(([t, v]) => [t, -v]);

  clip('walk', 1, [
    [legL, swing(0.55)],
    [legR, swingOpposite(0.55)],
    [armL, swingOpposite(0.4)],
    [armR, swing(0.4)],
  ]);

  clip('run', 1, [
    [legL, swing(0.95)],
    [legR, swingOpposite(0.95)],
    [armL, swingOpposite(0.75)],
    [armR, swing(0.75)],
  ]);

  clip('idle', 2, [
    [head, [[0, 0], [1, 0.06], [2, 0]]],
    [armL, [[0, 0], [1, -0.05], [2, 0]]],
    [armR, [[0, 0], [1, -0.05], [2, 0]]],
  ]);

  await mkdir(path.dirname(OUT), { recursive: true });
  await new NodeIO().write(OUT, doc);
  console.log(`Wrote ${path.relative(root, OUT)}`);
  console.log('Now run:  npm run assets');
}

main().catch((error) => {
  console.error('[test-rig] failed:', error);
  process.exitCode = 1;
});
