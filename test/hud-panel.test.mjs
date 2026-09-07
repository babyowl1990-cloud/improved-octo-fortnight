// node test/hud-panel.test.mjs
import * as THREE from 'three';

// ---- minimal DOM stub: a canvas + a permissive 2D context ----
// Any ctx method called (fillRect, fillText, strokeRect, ...) that we
// haven't explicitly listed just becomes a no-op via the Proxy, so
// this test doesn't need to track every Canvas2D API method by hand.
function makeMockCtx() {
  const calls = { fillText: 0 };
  const target = {
    fillText(...args) { calls.fillText++; },
  };
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === '_calls') return calls;
      return () => {};
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
  proxy._calls = calls;
  return proxy;
}

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    const ctx = makeMockCtx();
    return { width: 0, height: 0, getContext: () => ctx, _ctx: ctx };
  },
};

const { HUDPanel } = await import('../src/HUDPanel.js');
const { ScoreSystem } = await import('../src/ScoreSystem.js');
const { VehiclePhysics } = await import('../src/VehiclePhysics.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
const hud = new HUDPanel(camera, { redrawInterval: 1 / 12 });
const car = new VehiclePhysics();
const score = new ScoreSystem();

assert(camera.children.includes(hud.drivePanel), 'drive panel is attached to the camera');
assert(camera.children.includes(hud.gameOverPanel), 'game-over panel is attached to the camera');
assert(hud.gameOverPanel.visible === false, 'game-over panel starts hidden');

// ---- throttled redraw: texture shouldn't re-upload every single frame ----
let uploadCount = 0;
const origDescriptor = Object.getOwnPropertyDescriptor(THREE.Texture.prototype, 'needsUpdate');
// Simpler than patching the prototype: just count via a getter wrapper on the two textures.
for (const tex of [hud._driveTex, hud._overTex]) {
  let flag = false;
  Object.defineProperty(tex, 'needsUpdate', {
    get() { return flag; },
    set(v) { if (v) uploadCount++; flag = v; },
  });
}

for (let i = 0; i < 60; i++) hud.update(1 / 600, car, score); // 60 calls of 1/600s = 0.1s total, well under one redraw interval
assert(uploadCount <= 2, `redraw is throttled, not once per call (uploads=${uploadCount} over 60 sub-interval calls)`);

uploadCount = 0;
for (let i = 0; i < 120; i++) hud.update(1 / 30, car, score); // 4 seconds total at 30fps -> should redraw multiple times at 12Hz
assert(uploadCount > 5, `redraw happens repeatedly over real elapsed time (uploads=${uploadCount} over ~4s)`);

// ---- game-over transition redraws immediately, not after the next throttle window ----
uploadCount = 0;
score.registerCollision();
hud.update(0.0001, car, score); // near-zero dt — should still redraw because state just changed
assert(uploadCount >= 1, 'game-over transition forces an immediate redraw regardless of the throttle timer');
assert(hud.gameOverPanel.visible === true, 'game-over panel becomes visible once ScoreSystem reports gameOver');

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
