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

// --- Test 6: steering right (input.steer = +1) turns toward the driver's
// actual right, i.e. world -X — CameraRig.js aims the camera at the car's
// +Z front, and under that convention -X is the driver's right. This
// pins the exact sign bug found in testing (steer was inverted).
{
  const car = new VehiclePhysics();
  car.input.throttle = 0.5;
  for (let i = 0; i < 90 * 2; i++) car.update(DT); // get rolling straight first
  car.input.steer = 1; // full right
  for (let i = 0; i < 90 * 2; i++) car.update(DT);
  assert(car.position.x < -0.5, `steering right moves the car toward world -X, the driver's right (got x=${car.position.x.toFixed(2)})`);
}

// --- Test 7: stress test — rapid full-lock oscillating steering (a
// confused/fighting-the-controls player) at speed must never blow up.
// This directly checks the "spun out and flew off the map" report:
// the physics itself should stay bounded even under adversarial input,
// so any such incident is a real (if extreme) spin-out, not a NaN/divergence bug.
{
  const car = new VehiclePhysics();
  car.input.throttle = 1;
  for (let i = 0; i < 90 * 3; i++) car.update(DT); // get up to speed first
  let maxSpeedSeen = 0;
  for (let i = 0; i < 90 * 15; i++) {
    // Flip full-lock steering every few frames — about as adversarial as a human can physically input.
    car.input.steer = Math.floor(i / 6) % 2 === 0 ? 1 : -1;
    car.input.throttle = 1;
    car.update(DT);
    maxSpeedSeen = Math.max(maxSpeedSeen, car.speedMs);
    if (!Number.isFinite(car.position.x) || !Number.isFinite(car.position.z) ||
        !Number.isFinite(car.vx) || !Number.isFinite(car.vy) || !Number.isFinite(car.yawRate)) {
      break;
    }
  }
  assert(Number.isFinite(car.position.x) && Number.isFinite(car.position.z), 'position stays finite under rapid oscillating full-lock steering');
  assert(Number.isFinite(car.vx) && Number.isFinite(car.vy) && Number.isFinite(car.yawRate), 'velocity/yaw-rate stay finite under the same stress test');
  assert(maxSpeedSeen < 200, `speed never runs away to an absurd value even while spinning (${maxSpeedSeen.toFixed(1)} m/s peak)`);
}

// --- Test 8: the exact "spin out to 100,000+ mph" bug — an already-large
// yaw rate (as if something upstream briefly kicked the car into a hard
// spin) must NOT compound into runaway speed through the rotating-frame
// coupling terms. This is a regression test for a real numerical
// instability found during testing: naive forward-Euler integration of
// those terms grows the velocity vector's magnitude by a small factor
// EVERY step once yawRate*dt is large enough, compounding into an
// exponential blowup within a few seconds. Fixed by applying that
// coupling as an exact rotation instead of a linear approximation.
{
  for (const startYawRate of [2, 5, 10, 20, 50]) {
    const car = new VehiclePhysics();
    car.vx = 25; car.vy = 0; car.yawRate = startYawRate;
    car.input.throttle = 1;
    let blew = false;
    for (let i = 0; i < 180 * 10; i++) {
      car.update(DT);
      if (!Number.isFinite(car.speedKmh) || car.speedKmh > 1000) { blew = true; break; }
    }
    assert(!blew, `starting yawRate=${startYawRate} rad/s does not diverge to absurd speed`);
  }
}

console.log('\n' + (failures === 0 ? `ALL PASS` : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
