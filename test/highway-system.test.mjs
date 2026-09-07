// node test/highway-system.test.mjs
// Runs HighwaySystem headlessly (no WebGL) by exercising it against a
// real THREE.Scene (pure data — scene graph math needs no GPU) and a
// minimal `document.createElement('canvas')` stub for the one texture
// it generates. This can't verify pixels, but it DOES verify the part
// most likely to silently break during tuning: the recycler wiring
// that keeps instanced-mesh matrices sane as the car drives forever.

import * as THREE from 'three';

// ---- minimal DOM stub, just enough for _buildWindowTexture() ----
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    return {
      width: 0, height: 0,
      getContext() {
        return { fillStyle: '', fillRect() {} };
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

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
