# Highway VR Racer — complete scaffold

A VR-only highway cruising / traffic-weaving game. All four requested
systems are wired together and playable end to end: drive a lit,
multi-lane night highway, weave through AI traffic without colliding,
build a near-miss score multiplier, crash, and restart.

## Folder structure

```
highway-vr-racer/
├─ index.html                # entry point — import map + mounts the VR button
├─ src/
│  ├─ VehiclePhysics.js       # bicycle-model physics engine (no renderer dependency)
│  ├─ VRInputController.js    # WebXR controller + keyboard-fallback input mapping
│  ├─ CameraRig.js            # cockpit/chase camera, G-force/speed reactive FOV, VR-comfort-first
│  ├─ HighwaySystem.js        # endless multi-lane road, streetlights, skyline — instanced/pooled
│  ├─ RingRecycler.js         # shared pooling math for STATIC objects (road, streetlights)
│  ├─ AITrafficController.js  # pooled civilian traffic — lane changes, turn signals, collision/near-miss
│  ├─ ScoreSystem.js          # pure scoring/game-state logic (no renderer dependency)
│  ├─ HUDPanel.js             # in-VR canvas-texture HUD + game-over summary panel
│  └─ main.js                 # wires it all together, fixed-timestep loop
├─ vendor/three/              # Three.js r0.185 + VRButton + BufferGeometryUtils, vendored — no CDN
└─ test/                      # one test file per logic-heavy module — see "Running the tests" below
```

No build step. `npm`/`node_modules` were only ever used transiently to
pull exact Three.js build files during scaffolding — not required to run
the game, and not included in this zip.

## Running it -cmd-

1. **Serve the folder** (WebXR needs a secure context; plain
   `http://localhost` counts, no TLS cert needed):
   ```
   npx serve .
   ```
   or `python3 -m http.server 8080`
2. **Desktop first:** open the printed URL in Chrome/Edge, drive with
   WASD/arrows, press **C** to swap cockpit/chase view. The "Immersive
   Web Emulator" Chrome extension can simulate a full XR session
   (headset pose + controllers) without hardware.
3. **Real headset (e.g. Quest):** `adb reverse tcp:8080 tcp:8080` after
   plugging in via USB, then open `http://localhost:8080` in the Quest
   Browser and tap **Enter VR**.
4. to end `http://localhost:8080` go to cmd and press Ctrl-C

## Running the tests

Every logic-heavy module (anything that isn't purely "draw a mesh") has
a matching Node test — no browser needed:

```
node test/physics.test.mjs        # vehicle physics numeric stability
node test/ring-recycler.test.mjs  # static-object pooling math
node test/highway-system.test.mjs # instanced-mesh pooling, headless
node test/ai-traffic.test.mjs     # traffic pool, lane changes, collision/near-miss detection
node test/score-system.test.mjs   # multiplier growth/cap/decay, collision freeze
node test/hud-panel.test.mjs      # HUD wiring + redraw throttling, headless
```

All six currently pass. Re-run the relevant one after tuning anything.

## Controls

| Input | Desktop | VR |
|---|---|---|
| Steer | A/D or ←/→ | Left thumbstick X |
| Throttle | W or ↑ | Right trigger |
| Brake | S or ↓ | Left trigger |
| Handbrake | Space | Right grip/squeeze |
| Toggle cockpit/chase view | C | Right thumbstick click |
| Weight-shift lean | — | Physically lean your head left/right |
| Restart after a crash | Hold W/↑ | Hold right trigger |

## How the gameplay loop works

- **AI traffic** (`AITrafficController.js`): a fixed pool of civilian
  cars spawn ahead of you and respawn once they fall far enough behind
  — same "recycle, don't create/destroy" principle as the highway, but
  via a simple per-car distance check rather than `RingRecycler`,
  because these cars actually move at their own speed instead of
  sitting at a fixed `index * spacing` (see the file's header comment
  for why that distinction matters). Cars cruise in a random lane,
  occasionally signal and glide into an adjacent lane, and their speed
  is randomized within a range slower than your top speed — the whole
  point is that you can always eventually catch and weave past them.
- **Collision & near-miss** (also in `AITrafficController.js`): both
  are bounding-box checks against the player. A collision is an
  overlap. A near-miss is scored the instant you pass a car
  longitudinally while laterally close but not touching — so it
  triggers once per pass, not once per frame you happen to be near a car.
- **Scoring** (`ScoreSystem.js`): each near-miss adds points scaled by
  a multiplier that climbs with consecutive near-misses and decays
  back to 1x after a few quiet seconds — a "keep threading the needle"
  combo system, not a one-time bonus. A collision freezes everything
  and snapshots a final summary (score, distance, near-miss count).
- **HUD** (`HUDPanel.js`): speed/distance/score during play, plus a
  game-over summary panel. **This had to be built as in-world 3D
  geometry, not a flat HTML overlay** — a regular DOM element is
  invisible inside an actual immersive-vr WebXR session; only the
  rendered scene is visible through the headset. Both panels are
  canvas-texture planes attached to the camera, throttled to redraw at
  ~12Hz (except the game-over transition, which redraws immediately).

## Architecture decisions worth knowing about

- **Bicycle-model physics**, power-limited engine, fixed 1/180s
  timestep, VR-comfort-first camera (position-independent "shake" via
  FOV pulse, static cockpit reference) — see earlier drops' notes,
  unchanged here.
- **The entire highway is ~8 draw calls, however long it gets** —
  road, guardrails, streetlight fixtures, and skyline are each a
  single `THREE.InstancedMesh`. Only 4 real dynamic `PointLight`s ever
  exist, re-parked at the nearest streetlight stations each frame.
- **`RingRecycler` vs. `AITrafficController`'s own recycling:**
  `RingRecycler` is correct for objects whose position IS
  `index * spacing` and never changes otherwise (road, streetlights).
  Traffic cars move independently, so recycling them needed a
  different (simpler) trigger — see that file's header comment. Same
  underlying idea, different math, used where each actually applies.
- **Every non-visual module is pure and independently tested:**
  `VehiclePhysics`, `RingRecycler`, and `ScoreSystem` have zero
  rendering dependency and are unit-tested in plain Node.
  `HighwaySystem`, `AITrafficController`, and `HUDPanel` do need
  Three.js (and `HUDPanel` needs a `document.createElement('canvas')`
  stub) but are still tested headlessly — no WebGL context, no real
  browser, just the scene-graph math.
- **VR comfort shows up twice more here:** the chase camera and G-force
  FOV pulse were the first pass; this drop adds a HUD kept small and
  low-peripheral rather than centered/large (a HUD that's rigidly
  camera-locked and fills your view is its own mild discomfort source
  for some players), and the background world fully freezing on
  collision (nothing unexpected keeps moving while you're reading the
  summary screen).

## Key tunables

**`VehiclePhysics.js` / `CameraRig.js` / `HighwaySystem.js`** — unchanged
from earlier drops, see prior tuning tables (still accurate).

**`AITrafficController.js`**:

| Variable | Default | Effect |
|---|---|---|
| `poolSize` | 18 | Number of traffic cars alive at once |
| `minSpeed` / `maxSpeed` | 16 / 32 m/s | Civilian traffic speed range (player tops out ~65 m/s) |
| `laneChangeMinInterval` / `MaxInterval` | 4s / 12s | How often a cruising car decides to change lanes |
| `signalLeadTime` | 1.1s | How long the turn signal blinks before the car actually moves |
| `nearMissLateralMargin` | 0.6m | Extra clearance beyond "touching" that still counts as a scored near-miss |

**`ScoreSystem.js`**:

| Variable | Default | Effect |
|---|---|---|
| `pointsPerNearMiss` | 100 | Base points per near-miss, before the multiplier |
| `maxMultiplier` | 10 | Multiplier cap |
| `multiplierDecayTime` | 4.0s | Quiet time before the multiplier resets to 1x |

## Roadmap

1. ~~Vehicle physics + input~~
2. ~~Physics-driven camera (cockpit + chase)~~
3. ~~Endless highway (road, streetlights, skyline)~~
4. ~~AI traffic controller (pooling, lane changes, turn signals)~~
5. ~~Score/UI + collision + restart~~

All four originally requested systems are now in place. From here it's
polish: a real car/traffic model instead of placeholder boxes, gentle
road curvature, a world-locked (dashboard-mounted) HUD variant for
players who want maximum comfort, and engine/tire audio.
