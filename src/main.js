import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { VRInputController } from './VRInputController.js';
import { HighwaySystem } from './HighwaySystem.js';
import { CameraRig } from './CameraRig.js';

// ------------------------------------------------------------------
// Scene / renderer
// ------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x05070a, 0.010);

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
// Lighting — mostly ambient/moonlight; the highway's own streetlights
// (see HighwaySystem) do the real "night urban expressway" work.
// ------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x1c2436, 0x030405, 0.55));
const moonLight = new THREE.DirectionalLight(0x8fb8ff, 0.25);
moonLight.position.set(-30, 40, -10);
scene.add(moonLight);

// ------------------------------------------------------------------
// World systems
// ------------------------------------------------------------------
const highway = new HighwaySystem(scene, {});
const car = new VehiclePhysics();
const input = new VRInputController(renderer);
const cameraRig = new CameraRig(scene, camera, { comfort: 1.0 });

renderer.xr.addEventListener('sessionstart', () => input.recenterLean());

// ------------------------------------------------------------------
// Placeholder car chassis (boxes) — swap for a real model later;
// nothing else in this file needs to change when you do.
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
  [0.85, 0.33, 1.3], [-0.85, 0.33, 1.3],
  [0.85, 0.33, -1.3], [-0.85, 0.33, -1.3],
];
for (const [x, y, z] of wheelOffsets) {
  const wheel = new THREE.Mesh(wheelGeo, wheelMat);
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(x, y, z);
  carGroup.add(wheel);
}
scene.add(carGroup);

// Start centered in the middle lane, facing down the highway.
car.reset(highway.laneCenterX(Math.floor(highway.laneCount / 2)), 0, 0);

// ------------------------------------------------------------------
// Fixed-timestep physics loop (see VehiclePhysics.js for why this is
// decoupled from the XR render rate). The highway and camera systems
// are visual/following systems, not physics — they update once per
// rendered frame instead, using real elapsed time.
// ------------------------------------------------------------------
const FIXED_DT = 1 / 180;
const MAX_SUBSTEPS = 6;
let accumulator = 0;
let lastTime = performance.now();
const hud = document.getElementById('hud');

renderer.setAnimationLoop(() => {
  const now = performance.now();
  let frameTime = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

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

  if (input.state.viewToggled) cameraRig.toggleMode();

  // ---- Visual chassis ----
  carGroup.position.set(car.position.x, 0, car.position.z);
  carGroup.rotation.set(car.pitchAngle, car.heading, car.rollAngle, 'YXZ');

  // ---- World + camera follow the car ----
  highway.update(car.position.z);
  cameraRig.update(car, frameTime);

  hud.textContent =
    `speed    ${car.speedKmh.toFixed(0)} km/h  (${car.speedMph.toFixed(0)} mph)\n` +
    `distance ${car.position.z.toFixed(0)} m\n` +
    `view     ${cameraRig.mode}  (C / right-stick click to toggle)\n` +
    `g long/lat ${car.longitudinalG.toFixed(2)} / ${car.lateralG.toFixed(2)}\n` +
    `[WASD/arrows to test on desktop — trigger+grip in VR]`;

  renderer.render(scene, camera);
});
