// node test/ai-traffic.test.mjs
import * as THREE from 'three';
import { AITrafficController } from '../src/AITrafficController.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

// Minimal highway stand-in — AITrafficController only ever calls
// laneCount and laneCenterX(), so it doesn't need a real HighwaySystem.
function fakeHighway(laneCount = 3, laneWidth = 3.6) {
  return {
    laneCount,
    laneCenterX: (i) => (i - (laneCount - 1) / 2) * laneWidth,
  };
}

function allFinite(car) {
  return Number.isFinite(car.x) && Number.isFinite(car.z) && Number.isFinite(car.speed);
}

// --- Test 1: pool stays stable and finite over a long, irregular drive ---
{
  const scene = new THREE.Scene();
  const highway = fakeHighway();
  const traffic = new AITrafficController(scene, highway, { poolSize: 12 });

  let playerZ = 0;
  let sawStateChange = false;
  for (let i = 0; i < 4000; i++) {
    const dt = 1 / 60;
    playerZ += 20 * dt; // player cruising at 20 m/s
    traffic.update(0, playerZ, dt);
    if (traffic.cars.some(c => c.state !== 'cruise')) sawStateChange = true;
  }

  assert(traffic.cars.every(allFinite), 'every car stays finite after a long simulated drive');
  assert(traffic.cars.every(c => c.z > playerZ - traffic.behindDespawnDistance - 1),
    'no car is left further behind than the despawn threshold (respawn is keeping up)');
  assert(sawStateChange, 'at least one car entered signaling/changing state over the simulation');
}

// --- Test 2: a car directly on top of the player is detected as a collision ---
{
  const scene = new THREE.Scene();
  const highway = fakeHighway();
  const traffic = new AITrafficController(scene, highway, { poolSize: 1, aheadSpawnDistance: 10 });
  const car = traffic.cars[0];
  car.x = 5; car.z = 100; car.speed = 0;

  const result = traffic.update(5, 100, 1 / 60);
  assert(result.collidedWith === car, 'exact overlap with the player is reported as a collision');
}

// --- Test 3: passing closely without overlap registers exactly one near-miss ---
{
  const scene = new THREE.Scene();
  const highway = fakeHighway();
  const traffic = new AITrafficController(scene, highway, { poolSize: 1, aheadSpawnDistance: 10, nearMissLateralMargin: 0.6 });
  const car = traffic.cars[0];

  // Lateral gap ~0.3m beyond the combined half-widths (close, not touching).
  const combinedHalfWidth = traffic.halfWidth + traffic.playerHalfWidth;
  car.x = combinedHalfWidth + 0.3;
  car.speed = 0;

  // Frame A: car is 5m ahead of the player (relZ positive).
  car.z = 105;
  let result = traffic.update(0, 100, 1 / 60);
  assert(result.nearMisses.length === 0, 'no near-miss yet while still approaching');

  // Frame B: player has now passed the car (relZ sign flips negative).
  result = traffic.update(0, 106, 1 / 60);
  assert(result.nearMisses.length === 1 && result.nearMisses[0] === car,
    'passing closely without overlap registers exactly one near-miss at the moment of passing');

  // Frame C: still close by, no new sign flip — must NOT double-score.
  result = traffic.update(0, 106.5, 1 / 60);
  assert(result.nearMisses.length === 0, 'the same pass does not score a second near-miss');
}

// --- Test 4: resetAll() redistributes every car ahead of a new player position ---
{
  const scene = new THREE.Scene();
  const highway = fakeHighway();
  const traffic = new AITrafficController(scene, highway, { poolSize: 8, aheadSpawnDistance: 200 });
  traffic.resetAll(5000);
  assert(traffic.cars.every(c => c.z >= 5000), 'every car is placed ahead of the given player Z after resetAll()');
  assert(traffic.cars.every(c => c.nearMissScored === false), 'resetAll() clears the near-miss flag on every car');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
