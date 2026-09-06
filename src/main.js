import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { VRInputController } from './VRInputController.js';

// ------------------------------------------------------------------
// Scene / renderer
// ------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x05070a, 0.012);

const camera = new THREE.PerspectiveCamera(
  90, window.innerWidth / window.innerHeight, 0.05, 2000
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------
// Player rig — this is the trick that makes a VR "cockpit" work: the
// XR camera's pose is only ever relative to whatever local space it's
// added into. By putting `camera` inside a Group and moving/rotating
// THAT group to match the car every frame, the headset's own head
// tracking rides on top of the car's motion for free.
// ------------------------------------------------------------------
const playerRig = new THREE.Group();
playerRig.add(camera);
scene.add(playerRig);

// Seat position: slightly back and up from the car's origin (which we
// treat as the point midway between the rear axle contact patches).
const SEAT_OFFSET = new THREE.Vector3(0, 1.05, -0.35);

// ------------------------------------------------------------------
// Lighting (placeholder — the endless-highway system will add
// streetlights; this just keeps the harness visible/testable now)
// ------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x223344, 0x030405, 0.9));
const moonLight = new THREE.DirectionalLight(0x8fb8ff, 0.5);
moonLight.position.set(-30, 40, -10);
scene.add(moonLight);

// ------------------------------------------------------------------
// Placeholder ground (flat plane standing in for the highway surface
// until the endless-highway system replaces it)
// ------------------------------------------------------------------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshStandardMaterial({ color: 0x121620, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(4000, 400, 0x2a3550, 0x1a2030);
scene.add(grid);

// ------------------------------------------------------------------
// Placeholder car chassis (boxes) — just enough shape to SEE body
// roll/pitch and confirm orientation is correct. Swap for a real
// model later; nothing else in this file needs to change.
// ------------------------------------------------------------------
const carGroup = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.BoxGeometry(1.8, 0.55, 4.2),
  new THREE.MeshStandardMaterial({ color: 0xff3355, metalness: 0.3, roughness: 0.5 })
);
body.position.y = 0.55;
carGroup.add(body);

const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 16);
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
const wheelOffsets = [
  [0.85, 0.33, 1.3], [-0.85, 0.33, 1.3],   // front L/R
  [0.85, 0.33, -1.3], [-0.85, 0.33, -1.3], // rear L/R
];
for (const [x, y, z] of wheelOffsets) {
  const wheel = new THREE.Mesh(wheelGeo, wheelMat);
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(x, y, z);
  carGroup.add(wheel);
}
scene.add(carGroup);

// ------------------------------------------------------------------
// Physics + input
// ------------------------------------------------------------------
const car = new VehiclePhysics();
const input = new VRInputController(renderer);

renderer.xr.addEventListener('sessionstart', () => input.recenterLean());

// ------------------------------------------------------------------
// Fixed-timestep loop. VR headsets can vary refresh rate (72/90/120Hz)
// and a physics model this sensitive to slip/weight-transfer should
// NOT be stepped with a raw variable rAF delta — that makes tuning
// (and grip behavior) refresh-rate-dependent. We accumulate real time
// and step physics in fixed 1/180s slices, which stays stable even if
// the accumulator has to run 1-3 sub-steps in a single rendered frame.
// ------------------------------------------------------------------
const FIXED_DT = 1 / 180;
const MAX_SUBSTEPS = 6;
let accumulator = 0;
let lastTime = performance.now();
const hud = document.getElementById('hud');

renderer.setAnimationLoop(() => {
  const now = performance.now();
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;
  frameTime = Math.min(frameTime, 0.25); // guard against huge stalls

  accumulator += frameTime;
  let substeps = 0;
  while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
    input.update();
    car.input.steer = input.state.steer;
    car.input.throttle = input.state.throttle;
    car.input.brake = input.state.brake;
    car.input.handbrake = input.state.handbrake;
    car.input.leanAmount = input.state.leanAmount;

    car.update(FIXED_DT);
    accumulator -= FIXED_DT;
    substeps++;
  }

  // ---- Apply physics state to the visual chassis ----
  carGroup.position.set(car.position.x, 0, car.position.z);
  carGroup.rotation.set(car.pitchAngle, car.heading, car.rollAngle, 'YXZ');

  // ---- Move the player rig (cockpit view) to sit in the car ----
  const seatWorld = SEAT_OFFSET.clone()
    .applyEuler(new THREE.Euler(car.pitchAngle, car.heading, car.rollAngle, 'YXZ'))
    .add(new THREE.Vector3(car.position.x, 0, car.position.z));
  playerRig.position.copy(seatWorld);
  playerRig.rotation.set(car.pitchAngle, car.heading, car.rollAngle, 'YXZ');

  hud.textContent =
    `speed   ${car.speedKmh.toFixed(0)} km/h  (${car.speedMph.toFixed(0)} mph)\n` +
    `steer   ${car.currentSteerAngle.toFixed(2)} rad\n` +
    `slip f/r ${car.slipAngleFront.toFixed(2)} / ${car.slipAngleRear.toFixed(2)}\n` +
    `g long/lat ${car.longitudinalG.toFixed(2)} / ${car.lateralG.toFixed(2)}\n` +
    `[WASD / arrows to test on desktop — grip+trigger in VR]`;

  renderer.render(scene, camera);
});
