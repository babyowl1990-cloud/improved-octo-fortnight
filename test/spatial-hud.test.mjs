// node test/spatial-hud.test.mjs
import * as THREE from 'three';

function makeMockCtx() {
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 10 });
      return () => {};
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
}
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    const ctx = makeMockCtx();
    return { width: 0, height: 0, getContext: () => ctx };
  },
};

const { SpatialHUD } = await import('../src/SpatialHUD.js');
const { ScoreSystem } = await import('../src/ScoreSystem.js');
const { VehiclePhysics } = await import('../src/VehiclePhysics.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}
function finiteVec(v) { return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }
function finiteScale(g) { return Number.isFinite(g.scale.x) && g.scale.x > 0; }

const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
const hud = new SpatialHUD(camera, { redrawInterval: 1 / 12 });
const car = new VehiclePhysics();
const score = new ScoreSystem();

assert(camera.children.includes(hud.speedPanel.group), 'speed panel is attached to the camera');
assert(camera.children.includes(hud.scorePanel.group), 'score panel is attached to the camera');
assert(camera.children.includes(hud.gameOverPanel.group), 'game-over panel is attached to the camera');
assert(hud.gameOverPanel.group.visible === false, 'game-over panel starts hidden');
assert(hud.speedPanel.frame.geometry.attributes.position.count > 0, 'speed panel has real corner-bracket geometry, not just a texture');

// ---- renderOrder must be set on the MESHES, not just the parent group ----
// Regression test for a real bug: Three.js's WebGLRenderLists reads
// object.renderOrder directly off the renderable object being queued —
// it does not inherit from an ancestor Group. Setting it only on the
// group was a no-op, leaving screen/frame (two nearly-coplanar
// transparent, depthTest:false surfaces) to an unreliable draw-order
// tiebreak — exactly the recipe for flicker/wrong-layering.
for (const [name, panel] of [['speed', hud.speedPanel], ['score', hud.scorePanel], ['gameOver', hud.gameOverPanel]]) {
  assert(panel.screen.renderOrder > 0, `${name} panel's screen mesh has an explicit renderOrder set directly on it`);
  assert(panel.frame.renderOrder > panel.screen.renderOrder, `${name} panel's frame draws after (on top of) its screen`);
}

// ---- Boot-in animation: scale should start near 0 and settle to 1 ----
{
  hud.update(1 / 600, car, score); // first real update — this is when boot-in scale actually gets applied
  const startScale = hud.speedPanel.group.scale.x;
  for (let i = 0; i < 120; i++) hud.update(1 / 60, car, score); // 2s, past BOOT_DURATION
  assert(startScale < 0.5, 'boot-in starts small (near-zero scale) rather than popping straight to full size');
  assert(Math.abs(hud.speedPanel.group.scale.x - 1) < 0.01, 'boot-in settles to scale 1 after it finishes');
  assert(finiteScale(hud.speedPanel.group) && finiteScale(hud.scorePanel.group), 'panel scales stay finite throughout boot-in');
}

// ---- Near-miss punch: score panel should briefly scale up then decay back ----
{
  hud.pulseScore();
  hud.update(1 / 60, car, score);
  const punchedScale = hud.scorePanel.group.scale.x;
  assert(punchedScale > 1.0, 'score panel scales up immediately after a near-miss pulse');
  for (let i = 0; i < 60; i++) hud.update(1 / 60, car, score); // 1s of decay
  assert(Math.abs(hud.scorePanel.group.scale.x - 1) < 0.02, 'punch scale decays back down to ~1 afterward');
}

// ---- Restart re-triggers boot-in ----
{
  hud.bootIn();
  hud.update(1 / 60, car, score);
  assert(hud.speedPanel.group.scale.x < 0.9, 'calling bootIn() again (e.g. on restart) restarts the pop-in animation');
  for (let i = 0; i < 120; i++) hud.update(1 / 60, car, score);
}

// ---- Collision glitch: game-over panel becomes visible and jitters briefly, then settles ----
{
  score.registerCollision();
  hud.update(1 / 600, car, score); // near-zero dt, should still force a redraw + start the glitch
  assert(hud.gameOverPanel.group.visible === true, 'game-over panel becomes visible on collision');
  let sawJitter = false;
  for (let i = 0; i < 30; i++) {
    hud.update(1 / 60, car, score);
    if (hud.gameOverPanel.group.position.x !== 0) sawJitter = true;
    assert(finiteVec(hud.gameOverPanel.group.position), 'game-over panel position stays finite during the glitch');
  }
  assert(sawJitter, 'the collision glitch actually moves the panel briefly (not a no-op)');
  for (let i = 0; i < 60; i++) hud.update(1 / 60, car, score); // let the glitch finish
  assert(hud.gameOverPanel.group.position.x === 0, 'the glitch jitter settles back to a stable centered position');
  assert(finiteScale(hud.gameOverPanel.group), 'game-over panel scale stays finite throughout');
}

// ---- Settings panel: hidden by default, opens/closes, boots in like the others ----
{
  const { CarSettings } = await import('../src/CarSettings.js');
  const settings = new CarSettings();
  assert(hud.settingsPanel.group.visible === false, 'settings panel starts hidden');

  hud.update(1 / 600, car, score, true, settings); // open it — near-zero dt should still force a redraw
  assert(hud.settingsPanel.group.visible === true, 'settings panel becomes visible when settingsOpen is true');

  const openScale = hud.settingsPanel.group.scale.x;
  assert(openScale < 0.9, 'settings panel pops in from small scale, same boot-style animation as the other panels');
  for (let i = 0; i < 60; i++) hud.update(1 / 60, car, score, true, settings);
  assert(Math.abs(hud.settingsPanel.group.scale.x - 1) < 0.02, 'settings panel settles to full scale while open');

  hud.update(1 / 60, car, score, false, settings);
  assert(hud.settingsPanel.group.visible === false, 'settings panel hides again when settingsOpen becomes false');

  // Reopening restarts the pop-in rather than snapping straight to full size.
  hud.update(1 / 600, car, score, true, settings);
  assert(hud.settingsPanel.group.scale.x < 0.9, 'reopening the panel replays the boot-in animation from the start');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
