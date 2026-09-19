// node test/highway-system.test.mjs
// Runs HighwaySystem headlessly (no WebGL) by exercising it against a
// real THREE.Scene (pure data — scene graph math needs no GPU) and a
// minimal `document.createElement('canvas')` stub for the textures it
// generates (windows, asphalt noise, gantry/billboard signage). This
// can't verify pixels, but it DOES verify the part most likely to
// silently break during tuning: the recycler wiring that keeps
// instanced-mesh matrices sane as the car drives forever.

import * as THREE from 'three';

// ---- minimal DOM stub ----
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    const width = 0, height = 0;
    return {
      width, height,
      getContext() {
        return {
          fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '',
          fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
          getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
          putImageData() {},
        };
      },
    };
  },
};

const { HighwaySystem } = await import('../src/HighwaySystem.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

function allMatricesFinite(instancedMesh) {
  const arr = instancedMesh.instanceMatrix.array;
  return arr.every(Number.isFinite);
}

const scene = new THREE.Scene();
const highway = new HighwaySystem(scene, {});

assert(allMatricesFinite(highway.roadMesh), 'road instance matrices finite at init');
assert(allMatricesFinite(highway.railMesh), 'guardrail instance matrices finite at init');
assert(allMatricesFinite(highway.poleMesh.left), 'pole (left) instance matrices finite at init');
assert(allMatricesFinite(highway.skylineMesh.right), 'skyline (right) instance matrices finite at init');
assert(highway.realLights.length === 4, 'default real-light pool is small and fixed (4)');

// Drive forward for 5km in irregular steps and make sure nothing breaks.
let carZ = 0;
for (let i = 0; i < 500; i++) {
  carZ += 5 + Math.random() * 15; // irregular step sizes on purpose
  highway.update(carZ);
}

assert(allMatricesFinite(highway.roadMesh), 'road instance matrices stay finite after 5km of driving');
assert(allMatricesFinite(highway.railMesh), 'guardrail instance matrices stay finite after 5km');
assert(allMatricesFinite(highway.poleMesh.left), 'pole (left) matrices stay finite after 5km');
assert(allMatricesFinite(highway.poleMesh.right), 'pole (right) matrices stay finite after 5km');
assert(allMatricesFinite(highway.lampMesh.left), 'lamp (left) matrices stay finite after 5km');
assert(allMatricesFinite(highway.skylineMesh.left), 'skyline (left) matrices stay finite after 5km');
assert(allMatricesFinite(highway.skylineMesh.right), 'skyline (right) matrices stay finite after 5km');

for (const light of highway.realLights) {
  assert(Number.isFinite(light.position.x) && Number.isFinite(light.position.z), 'real light position stays finite');
}

// The pool must still cover "far enough ahead" of the car at all times.
const desiredMax = Math.floor(carZ / highway.segmentLength) + highway.segmentsAhead;
assert(highway.roadRecycler.maxIndex >= desiredMax, 'road pool still covers the required ahead-window after driving');
assert(highway.roadRecycler.maxIndex - highway.roadRecycler.minIndex + 1 === highway.roadMesh.count,
  'road recycler window width matches instance count (no slot lost/duplicated)');

// Simulate a big single-frame jump (e.g. a respawn) and confirm recovery.
highway.update(carZ + 50000);
assert(allMatricesFinite(highway.roadMesh), 'road survives a huge single-frame jump (respawn scenario)');
assert(allMatricesFinite(highway.skylineMesh.left), 'skyline survives a huge single-frame jump');

// --- Test: reset() re-anchors every pool around a NEW (lower) player Z ---
// Regression test for the "map glitches after a crash" report: without
// reset(), driving far (say to z=5000) then teleporting back to z=0 on
// restart left every pool still anchored near z=5000, since RingRecycler
// only ever recycles forward.
{
  const farZ = 5000;
  highway.update(farZ); // simulate having driven far down the highway
  highway.reset(0); // simulate a post-collision restart back at the start

  const roadDesiredMax = Math.floor(0 / highway.segmentLength) + highway.segmentsAhead;
  assert(Math.abs(highway.roadRecycler.maxIndex - roadDesiredMax) <= highway.roadMesh.count,
    'road pool is re-anchored near the new player Z, not still around the old far position');
  assert(Math.abs(highway.poleRecycler.maxIndex * highway.lightSpacing) < 2000,
    'streetlight pool is re-anchored near the new player Z');
  assert(Math.abs(highway.skylineRecycler.left.maxIndex * highway.skylineRecycler.left.spacing) < 2000,
    'skyline pool is re-anchored near the new player Z');
  assert(allMatricesFinite(highway.roadMesh) && allMatricesFinite(highway.poleMesh.left) && allMatricesFinite(highway.skylineMesh.left),
    'every pool stays finite immediately after reset()');

  // And normal driving from the new position should still work correctly afterward.
  let z2 = 0;
  for (let i = 0; i < 200; i++) { z2 += 10; highway.update(z2); }
  assert(allMatricesFinite(highway.roadMesh), 'driving normally after reset() still stays finite');
}

// --- reflectors, gantries, and billboards: same finite/reset coverage as everything else ---
{
  const scene = new THREE.Scene();
  const highway = new HighwaySystem(scene, {});

  assert(allMatricesFinite(highway.reflectorMesh), 'reflector instance matrices finite at init');
  assert(allMatricesFinite(highway.gantryStructMesh) && allMatricesFinite(highway.gantryPanelMesh),
    'gantry structure/panel matrices finite at init');
  assert(allMatricesFinite(highway.billboardPoleMesh) && allMatricesFinite(highway.billboardPanelMesh),
    'billboard pole/panel matrices finite at init');
  assert(highway.reflectorMesh.count === highway.roadMesh.count,
    'reflector pool shares the road pool\'s slot count (same recycler, no separate pool needed)');

  let z = 0;
  for (let i = 0; i < 500; i++) { z += 5 + Math.random() * 15; highway.update(z); }
  assert(allMatricesFinite(highway.reflectorMesh), 'reflector matrices stay finite after 5km of driving');
  assert(allMatricesFinite(highway.gantryStructMesh) && allMatricesFinite(highway.gantryPanelMesh),
    'gantry matrices stay finite after 5km of driving');
  assert(allMatricesFinite(highway.billboardPoleMesh) && allMatricesFinite(highway.billboardPanelMesh),
    'billboard matrices stay finite after 5km of driving');

  const gantryDesiredMax = Math.floor(z / highway.gantrySpacing) + highway.gantryAhead;
  assert(highway.gantryRecycler.maxIndex >= gantryDesiredMax, 'gantry pool keeps covering the required ahead-window');
  const billboardDesiredMax = Math.floor(z / highway.billboardSpacing) + highway.billboardAhead;
  assert(highway.billboardRecycler.maxIndex >= billboardDesiredMax, 'billboard pool keeps covering the required ahead-window');

  // Restart regression coverage — same bug class as the road/streetlight/skyline reset fix.
  highway.reset(0);
  assert(allMatricesFinite(highway.gantryStructMesh) && allMatricesFinite(highway.billboardPoleMesh),
    'gantry/billboard matrices stay finite immediately after reset()');
  assert(Math.abs(highway.gantryRecycler.maxIndex * highway.gantrySpacing) < 5000,
    'gantry pool is re-anchored near the new player Z after reset(), not left around the old far position');
  assert(Math.abs(highway.billboardRecycler.maxIndex * highway.billboardSpacing) < 5000,
    'billboard pool is re-anchored near the new player Z after reset()');
  assert(Math.abs(highway.ground.position.z) < 1e-6, 'ground plane re-centers to the reset position too');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
