// Quick numerical sanity check for VehiclePhysics — run with:
//   node test/physics.test.mjs
// This is NOT a full unit test suite, just a fast smoke test to catch
// NaN/instability/unrealistic numbers before handing the model off.

import { VehiclePhysics } from '../src/VehiclePhysics.js';

const DT = 1 / 90; // simulate at a VR-typical 90Hz
let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

function isFinitePose(car) {
  return Number.isFinite(car.position.x) && Number.isFinite(car.position.z) &&
    Number.isFinite(car.vx) && Number.isFinite(car.vy) && Number.isFinite(car.yawRate);
}

// --- Test 1: straight-line full throttle from rest ---
{
  const car = new VehiclePhysics();
  car.input.throttle = 1;
  let seconds = 0;
  for (let i = 0; i < 90 * 12; i++) { car.update(DT); seconds += DT; }
  assert(isFinitePose(car), 'straight-line accel stays finite (no NaN/Infinity)');
  assert(car.speedKmh > 60 && car.speedKmh < 260, `reaches a plausible top-ish speed after 12s (${car.speedKmh.toFixed(1)} km/h)`);
  assert(car.speedKmh < 400, 'does not runaway to absurd speed');
}

// --- Test 2: braking from speed actually slows the car ---
{
  const car = new VehiclePhysics();
  car.input.throttle = 1;
  for (let i = 0; i < 90 * 6; i++) car.update(DT);
  const speedBefore = car.speedKmh;
  car.input.throttle = 0;
  car.input.brake = 1;
  for (let i = 0; i < 90 * 3; i++) car.update(DT);
  assert(isFinitePose(car), 'braking stays finite');
  assert(car.speedKmh < speedBefore, `braking reduces speed (${speedBefore.toFixed(1)} -> ${car.speedKmh.toFixed(1)} km/h)`);
}

// --- Test 3: steady steering at speed produces a turn without diverging ---
{
  const car = new VehiclePhysics();
  car.input.throttle = 0.6;
  for (let i = 0; i < 90 * 3; i++) car.update(DT); // get up to speed straight
  const headingBefore = car.heading;
  car.input.steer = 0.4;
  for (let i = 0; i < 90 * 3; i++) car.update(DT);
  assert(isFinitePose(car), 'cornering stays finite');
  assert(car.heading !== headingBefore, 'steering input changes heading');
  assert(Math.abs(car.lateralG) < 3, `lateral G stays within a plausible range (${car.lateralG.toFixed(2)}g)`);
  assert(Math.abs(car.rollAngle) <= car.maxRollAngle + 1e-6, 'visual roll angle respects its configured max');
}

// --- Test 4: handbrake at speed induces rear slip (oversteer) without NaN ---
{
  const car = new VehiclePhysics();
  car.input.throttle = 0.8;
  for (let i = 0; i < 90 * 3; i++) car.update(DT);
  car.input.throttle = 0;
  car.input.steer = 0.5;
  car.input.handbrake = true;
  for (let i = 0; i < 90 * 2; i++) car.update(DT);
  assert(isFinitePose(car), 'handbrake turn stays finite');
  assert(Math.abs(car.slipAngleRear) > Math.abs(car.slipAngleFront) * 0.5, 'handbrake noticeably increases relative rear slip');
}

// --- Test 5: reset() returns to a clean stationary state ---
{
  const car = new VehiclePhysics();
  car.input.throttle = 1;
  for (let i = 0; i < 90 * 5; i++) car.update(DT);
  car.reset(10, 20, 1.0);
  assert(car.position.x === 10 && car.position.z === 20 && car.heading === 1.0, 'reset() places car at requested pose');
  assert(car.vx === 0 && car.vy === 0 && car.speedKmh === 0, 'reset() zeroes velocity/speed');
}

console.log('\n' + (failures === 0 ? `ALL PASS` : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
