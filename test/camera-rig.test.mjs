// node test/camera-rig.test.mjs
import * as THREE from 'three';
import { CameraRig } from '../src/CameraRig.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

function approxEqualVec(a, b, eps = 1e-4) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

function fakeCar({ x = 0, z = 0, heading = 0, pitch = 0, roll = 0 } = {}) {
  return {
    position: { x, z },
    heading, pitchAngle: pitch, rollAngle: roll,
    longitudinalG: 0, lateralG: 0, speedMs: 0,
  };
}

// The car's own visual front, independent of CameraRig — this is what
// wheels/signal-lights/etc. were all built against (local +Z). Any
// camera mode should end up looking in THIS direction, not away from it.
function carFrontDirection(car) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(car.pitchAngle, car.heading, car.rollAngle, 'YXZ')
  );
  return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
}

// --- Test 1: cockpit camera looks the same way the car's front does, at heading 0 ---
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const rig = new CameraRig(scene, camera, {});
  const car = fakeCar({ heading: 0 });

  rig.update(car, 1 / 60);
  const lookDir = new THREE.Vector3();
  camera.getWorldDirection(lookDir);

  assert(approxEqualVec(lookDir, carFrontDirection(car)),
    `cockpit camera looks toward the car's front at heading=0 (got ${lookDir.x.toFixed(2)},${lookDir.y.toFixed(2)},${lookDir.z.toFixed(2)})`);
}

// --- Test 2: same invariant holds at an arbitrary non-zero heading ---
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const rig = new CameraRig(scene, camera, {});
  const car = fakeCar({ heading: 1.7 }); // arbitrary angle, not a special case like 0/90/180

  rig.update(car, 1 / 60);
  const lookDir = new THREE.Vector3();
  camera.getWorldDirection(lookDir);

  assert(approxEqualVec(lookDir, carFrontDirection(car)),
    'cockpit camera still matches the car\'s front direction at an arbitrary heading');
}

// --- Test 3: chase camera sits BEHIND the car (opposite its front direction), not ahead of it ---
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const rig = new CameraRig(scene, camera, {});
  rig.toggleMode(); // cockpit -> chase, before any update() call
  const car = fakeCar({ heading: 0 });

  rig.update(car, 1 / 60);

  const carPos = new THREE.Vector3(car.position.x, 0, car.position.z);
  const front = carFrontDirection(car);
  const toCamera = rig.playerRig.position.clone().sub(carPos).normalize();
  const behindDot = toCamera.dot(front); // should be negative: camera is opposite the front direction

  assert(behindDot < -0.9, `chase camera sits behind the car, opposite its front direction (dot=${behindDot.toFixed(2)})`);

  const lookDir = new THREE.Vector3();
  camera.getWorldDirection(lookDir);
  assert(approxEqualVec(lookDir, front), 'chase camera looks the same direction the car is facing (forward), not backward at itself');
}

// --- Test 4: chase camera also holds the invariant at a non-zero heading ---
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const rig = new CameraRig(scene, camera, {});
  rig.toggleMode();
  const car = fakeCar({ heading: -0.9 });

  rig.update(car, 1 / 60);
  const lookDir = new THREE.Vector3();
  camera.getWorldDirection(lookDir);
  assert(approxEqualVec(lookDir, carFrontDirection(car)), 'chase camera direction matches car front at a non-zero heading too');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
