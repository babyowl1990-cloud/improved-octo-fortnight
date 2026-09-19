// node test/car-model.test.mjs
import * as THREE from 'three';
import { buildCarBodyGeometry, addCarLights } from '../src/CarModel.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

// --- merged body geometry is valid and finite ---
{
  const geo = buildCarBodyGeometry(0xff3355);
  const pos = geo.attributes.position;
  assert(pos && pos.count > 0, 'merged car geometry has vertex data');
  assert(geo.attributes.color && geo.attributes.color.count === pos.count,
    'every vertex has a baked color (body/cabin/roof/mirrors/wheels can each show a different tone)');
  let allFinite = true;
  for (let i = 0; i < pos.count; i++) {
    if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) allFinite = false;
  }
  assert(allFinite, 'every vertex position is finite (no NaN from a bad merge)');

  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  // Mirrors/bumpers intentionally poke a little past the main body box —
  // normal for a visual mesh vs. a simplified collision box, so this
  // allows for that overhang rather than requiring an exact match.
  assert(size.x > 1.8 && size.x < 2.1, `overall width is close to 1.8m plus mirror overhang, not wildly off (got ${size.x.toFixed(2)})`);
  assert(size.z > 4.2 && size.z < 4.4, `overall length is close to 4.2m plus bumper overhang, not wildly off (got ${size.z.toFixed(2)})`);
}

// --- different paint colors actually produce different baked vertex colors ---
{
  const red = buildCarBodyGeometry(0xff0000);
  const blue = buildCarBodyGeometry(0x0000ff);
  const redFirstColor = [red.attributes.color.getX(0), red.attributes.color.getY(0), red.attributes.color.getZ(0)];
  const blueFirstColor = [blue.attributes.color.getX(0), blue.attributes.color.getY(0), blue.attributes.color.getZ(0)];
  assert(redFirstColor[0] > 0.9 && redFirstColor[2] < 0.1, 'a red paint color bakes red into the body vertices');
  assert(blueFirstColor[2] > 0.9 && blueFirstColor[0] < 0.1, 'a blue paint color bakes blue into the body vertices, proving the color param actually changes output');
}

// --- lights ---
{
  const group = new THREE.Group();
  addCarLights(group);
  const lamps = group.children.filter((c) => c.isMesh);
  assert(lamps.length === 4, `addCarLights adds exactly 4 lamp meshes (2 headlights + 2 taillights), got ${lamps.length}`);
  const front = lamps.filter((m) => m.position.z > 0);
  const rear = lamps.filter((m) => m.position.z < 0);
  assert(front.length === 2 && rear.length === 2, 'two lamps sit at the front, two at the rear');
  assert(front.every((m) => m.material.emissive.g > 0.8), 'front lamps (headlights) are a warm/white emissive, not red');
  assert(rear.every((m) => m.material.emissive.r > 0.8 && m.material.emissive.g < 0.3), 'rear lamps (taillights) are red emissive');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
