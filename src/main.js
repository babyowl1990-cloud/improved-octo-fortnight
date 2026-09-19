import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { VRInputController } from './VRInputController.js';
import { HighwaySystem } from './HighwaySystem.js';
import { CameraRig } from './CameraRig.js';
import { AITrafficController } from './AITrafficController.js';
import { ScoreSystem } from './ScoreSystem.js';
import { SpatialHUD } from './SpatialHUD.js';
import { buildCarBodyGeometry, addCarLights } from './CarModel.js';
import { CarSettings } from './CarSettings.js';

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
const hud = new SpatialHUD(camera, {});

renderer.xr.addEventListener('sessionstart', () => input.recenterLean());

// ------------------------------------------------------------------
// Player car chassis — shared body/lights builder, same one traffic
// cars use (see CarModel.js), so the player isn't stuck as a plain
// box while every AI car got the upgraded silhouette + lights.
// `carBodyMesh` is kept around so the settings menu can swap its
// geometry live when the player changes paint color.
// ------------------------------------------------------------------
const carGroup = new THREE.Group();
const carBodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
let playerPaintColor = 0xff3355;
const carBodyMesh = new THREE.Mesh(buildCarBodyGeometry(playerPaintColor), carBodyMat);
carGroup.add(carBodyMesh);
addCarLights(carGroup);
scene.add(carGroup);

function setPlayerPaintColor(colorHex) {
  playerPaintColor = colorHex;
  const oldGeo = carBodyMesh.geometry;
  carBodyMesh.geometry = buildCarBodyGeometry(colorHex);
  oldGeo.dispose();
}

// ------------------------------------------------------------------
// Car settings menu — toggled with M (keyboard) or left grip (VR).
// Applying a change pushes it straight into the live systems below;
// see the render loop for how the menu freezes driving and reuses
// steer/throttle/brake as navigate/adjust input while it's open.
// ------------------------------------------------------------------
const settings = new CarSettings();
let settingsOpen = false;

function applySettings() {
  const g = settings.grip;
  car.tireFriction = g.tireFriction;
  car.corneringStiffnessFront = g.corneringStiffnessFront;
  car.corneringStiffnessRear = g.corneringStiffnessRear;
  car.handbrakeForceMax = g.handbrakeForceMax;
  cameraRig.comfort = settings.comfort.value;
  setPlayerPaintColor(settings.paint.hex);
  const wantMode = settings.view === 'COCKPIT' ? 'cockpit' : 'chase';
  if (cameraRig.mode !== wantMode) cameraRig.toggleMode();
}
applySettings(); // settings' own defaults already match the systems' defaults, but this keeps them in sync from frame 1 rather than by manual coordination

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
// How far the car can travel before the world gets "re-centered" back
// near Z=0. WebGL stores vertex/instance data as 32-bit floats, which
// only have about 7 significant decimal digits — fine at normal
// distances, but sub-meter precision starts eroding once coordinates
// climb into very large numbers, and a long enough uninterrupted drive
// gets there. Comfortably before that point, this shifts the car, every
// traffic car, and the highway pools all backward by the same amount in
// the same frame — completely invisible to the player, since nothing
// moves RELATIVE to anything else — while `totalDistance` (used for the
// HUD/score) keeps counting up normally, since it's tracked separately
// from the position values that get rebased.
const REBASE_THRESHOLD = 20000; // meters
let accumulator = 0;
let restartHoldTimer = 0;
let totalDistance = 0;
let lastTime = performance.now();
// Rising-edge tracking for menu navigation — reusing throttle/brake/steer
// as up/down/left-right while the menu is open (see the loop below for
// why that's safe), which needs its own debounce so a held input doesn't
// race through options every single frame.
let prevNavUp = false, prevNavDown = false, prevNavLeft = false, prevNavRight = false;
const debugHud = document.getElementById('hud'); // flat 2D overlay, desktop-testing only — see SpatialHUD.js for the real in-VR HUD

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameTime = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  if (!score.gameOver) {
    // Input is sampled ONCE per rendered frame, before the physics
    // sub-step loop — not once per sub-step. This matters specifically
    // for viewToggled/menuToggled: they're rising-edge flags (true for
    // one sample only), computed fresh on every input.update() call.
    // FIXED_DT (1/180s) is finer than any real display's frame rate, so
    // multiple sub-steps routinely run per rendered frame; calling
    // input.update() inside that loop was setting these flags true on
    // the first sub-step and then immediately overwriting them back to
    // false on the second/third sub-step of that SAME frame, before this
    // code ever got to check them below — so the toggle almost never
    // actually fired. Sampling once per frame and reusing the same
    // input.state across however many sub-steps that frame needs fixes this.
    input.update();

    if (input.state.menuToggled) settingsOpen = !settingsOpen;
    if (input.state.viewToggled) cameraRig.toggleMode();

    if (settingsOpen) {
      // Menu navigation reuses the driving axes rather than adding a
      // parallel input scheme: throttle/brake become up/down, steer
      // becomes left/right. Safe specifically because physics/traffic
      // are frozen below while the menu is open, so there's no
      // "driving" for these inputs to also be doing at the same time.
      const navUp = input.state.throttle > 0.5;
      const navDown = input.state.brake > 0.5;
      const navLeft = input.state.steer < -0.5;
      const navRight = input.state.steer > 0.5;
      if (navUp && !prevNavUp) settings.moveSelection(-1);
      if (navDown && !prevNavDown) settings.moveSelection(1);
      if (navLeft && !prevNavLeft) { settings.adjustSelected(-1); applySettings(); }
      if (navRight && !prevNavRight) { settings.adjustSelected(1); applySettings(); }
      prevNavUp = navUp; prevNavDown = navDown; prevNavLeft = navLeft; prevNavRight = navRight;
    } else {
      car.input.steer = input.state.steer;
      car.input.throttle = input.state.throttle;
      car.input.brake = input.state.brake;
      car.input.handbrake = input.state.handbrake;
      car.input.leanAmount = input.state.leanAmount;

      const zBeforeStep = car.position.z;
      accumulator += frameTime;
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
        car.update(FIXED_DT);
        accumulator -= FIXED_DT;
        substeps++;
      }
      totalDistance += car.position.z - zBeforeStep;

      const { collidedWith, nearMisses } = traffic.update(car.position.x, car.position.z, frameTime);
      score.tick(frameTime, totalDistance);
      for (let i = 0; i < nearMisses.length; i++) score.registerNearMiss();
      if (nearMisses.length > 0) hud.pulseScore();
      if (collidedWith) score.registerCollision();

      // World rebase — see REBASE_THRESHOLD comment above. Shifting by
      // exactly car.position.z puts the car back at Z=0; every traffic
      // car shifts by the same amount so its distance from the player is
      // unchanged, and highway.reset() re-anchors the road/streetlight/
      // skyline pools around the new (small) position, reusing the exact
      // same mechanism already built and tested for the post-crash restart.
      if (car.position.z > REBASE_THRESHOLD) {
        const shift = car.position.z;
        car.position.z -= shift;
        traffic.shiftAll(-shift);
        highway.reset(car.position.z);
        cameraRig.resetFollow();
      }
    }
  } else {
    // Still read input (just not physics) so we can detect the
    // "hold throttle to restart" gesture from the game-over screen.
    input.update();
    restartHoldTimer = input.state.throttle > 0.5 ? restartHoldTimer + frameTime : 0;
    if (restartHoldTimer > RESTART_HOLD_SECONDS) {
      car.reset(startingLaneX(), 0, 0);
      score.reset();
      traffic.resetAll(0);
      highway.reset(0);
      cameraRig.resetFollow();
      hud.bootIn();
      totalDistance = 0;
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
  hud.update(frameTime, car, score, settingsOpen, settings);

  debugHud.textContent =
    `speed    ${car.speedKmh.toFixed(0)} km/h  (${car.speedMph.toFixed(0)} mph)\n` +
    `distance ${car.position.z.toFixed(0)} m   score ${score.score}  x${score.multiplier}\n` +
    `view     ${cameraRig.mode}  (C / right-stick click to toggle)\n` +
    `menu     ${settingsOpen ? 'OPEN (M to close)' : 'closed (M to open)'}\n` +
    `state    ${score.gameOver ? 'GAME OVER — hold throttle to restart' : 'driving'}\n` +
    `[WASD/arrows to test on desktop — trigger+grip in VR]`;

  renderer.render(scene, camera);
});
