import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { VRInputController } from './VRInputController.js';
import { HighwaySystem } from './HighwaySystem.js';
import { CameraRig } from './CameraRig.js';
import { AITrafficController } from './AITrafficController.js';
import { ScoreSystem } from './ScoreSystem.js';
import { HUDPanel } from './HUDPanel.js';

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
// World / gameplay systems
// ------------------------------------------------------------------
const highway = new HighwaySystem(scene, {});
const car = new VehiclePhysics();
const input = new VRInputController(renderer);
const cameraRig = new CameraRig(scene, camera, { comfort: 1.0 });
const traffic = new AITrafficController(scene, highway, {});
const score = new ScoreSystem({});
const hud = new HUDPanel(camera, {});

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
for (const [x, y, z] of [[0.85, 0.33, 1.3], [-0.85, 0.33, 1.3], [0.85, 0.33, -1.3], [-0.85, 0.33, -1.3]]) {
  const wheel = new THREE.Mesh(wheelGeo, wheelMat);
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(x, y, z);
  carGroup.add(wheel);
}
scene.add(carGroup);

function startingLaneX() {
  return highway.laneCenterX(Math.floor(highway.laneCount / 2));
}
car.reset(startingLaneX(), 0, 0);

// ------------------------------------------------------------------
// Fixed-timestep physics loop (see VehiclePhysics.js for why). The
// highway/camera/traffic/HUD are visual or gameplay-timing systems,
// not physics — they update once per rendered frame using real
// elapsed time instead of the fixed sub-step.
//
// While score.gameOver is true, the physics sub-step and traffic
// update are both skipped entirely — the world freezes on the crash
// (including the AI traffic pool) until the player holds throttle to
// restart. That's a deliberate simplification for this drop; a more
// polished version might keep background traffic animating during
// the game-over screen.
// ------------------------------------------------------------------
const FIXED_DT = 1 / 180;
const MAX_SUBSTEPS = 6;
const RESTART_HOLD_SECONDS = 0.6;
let accumulator = 0;
let restartHoldTimer = 0;
let lastTime = performance.now();
const debugHud = document.getElementById('hud'); // flat 2D overlay, desktop-testing only — see HUDPanel.js for the real in-VR HUD

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameTime = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  if (!score.gameOver) {
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

    const { collidedWith, nearMisses } = traffic.update(car.position.x, car.position.z, frameTime);
    score.tick(frameTime, car.position.z);
    for (let i = 0; i < nearMisses.length; i++) score.registerNearMiss();
    if (collidedWith) score.registerCollision();
  } else {
    // Still read input (just not physics) so we can detect the
    // "hold throttle to restart" gesture from the game-over screen.
    input.update();
    restartHoldTimer = input.state.throttle > 0.5 ? restartHoldTimer + frameTime : 0;
    if (restartHoldTimer > RESTART_HOLD_SECONDS) {
      car.reset(startingLaneX(), 0, 0);
      score.reset();
      traffic.resetAll(0);
      accumulator = 0;
      restartHoldTimer = 0;
    }
  }

  // ---- Visual chassis ----
  carGroup.position.set(car.position.x, 0, car.position.z);
  carGroup.rotation.set(car.pitchAngle, car.heading, car.rollAngle, 'YXZ');

  // ---- World + camera + HUD ----
  highway.update(car.position.z);
  cameraRig.update(car, frameTime);
  hud.update(frameTime, car, score);

  debugHud.textContent =
    `speed    ${car.speedKmh.toFixed(0)} km/h  (${car.speedMph.toFixed(0)} mph)\n` +
    `distance ${car.position.z.toFixed(0)} m   score ${score.score}  x${score.multiplier}\n` +
    `view     ${cameraRig.mode}  (C / right-stick click to toggle)\n` +
    `state    ${score.gameOver ? 'GAME OVER — hold throttle to restart' : 'driving'}\n` +
    `[WASD/arrows to test on desktop — trigger+grip in VR]`;

  renderer.render(scene, camera);
});
