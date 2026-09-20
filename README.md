# Highway VR Racer — test scaffold

A VR-only highway cruising / traffic-weaving game. All four originally
requested systems are wired together and playable end to end, on top of
a full visual pass: a detailed car model (shared between player and
traffic), a textured/detailed environment, and an in-car settings menu.

Heads up: there are rendering issues sorry...

## Folder structure

```
highway-vr-racer/
├─ index.html                # entry point — import map, @font-face, mounts the VR button
├─ src/
│  ├─ VehiclePhysics.js       # bicycle-model physics engine (no renderer dependency)
│  ├─ VRInputController.js    # WebXR controller + keyboard-fallback input mapping
│  ├─ CameraRig.js            # cockpit/chase camera, G-force/speed reactive FOV, VR-comfort-first
│  ├─ CarModel.js             # shared procedural car body/lights — player AND traffic use this
│  ├─ CarSettings.js          # pure settings state (grip/paint/comfort/view) for the in-car menu
│  ├─ HighwaySystem.js        # endless multi-lane road + ground, streetlights, skyline, gantries, billboards
│  ├─ RingRecycler.js         # shared pooling math for STATIC objects (road, streetlights, gantries, billboards)
│  ├─ AITrafficController.js  # pooled civilian traffic — lane changes, turn signals, collision/near-miss
│  ├─ ScoreSystem.js          # pure scoring/game-state logic (no renderer dependency)
│  ├─ SpatialHUD.js           # cyberpunk/terminal spatial HUD — bracket-framed panels incl. settings menu
│  └─ main.js                 # wires it all together, fixed-timestep loop
├─ vendor/three/              # Three.js r0.185 + VRButton + BufferGeometryUtils, vendored — no CDN
├─ vendor/fonts/               # Orbitron (500/700/900), vendored from @fontsource — no Google Fonts CDN
└─ test/                      # one test file per logic-heavy module — see "Running the tests" below
```

No build step. `npm`/`node_modules` were only ever used transiently to
pull exact Three.js/font files during scaffolding — not required to run
the game, and not included in this zip.

## Running it

1. **Serve the folder** (WebXR needs a secure context; plain
   `http://localhost` counts, no TLS cert needed):
   ```
   npx serve .
   ```
   or `python3 -m http.server 8080`
2. **Desktop first:** open the printed URL in Chrome/Edge, drive with
   WASD/arrows, press **C** to swap cockpit/chase view, **M** for the
   settings menu. The "Immersive Web Emulator" Chrome extension can
   simulate a full XR session (headset pose + controllers) without hardware.
3. **Real headset (e.g. Quest):** `adb reverse tcp:8080 tcp:8080` after
   plugging in via USB, then open `http://localhost:8080` in the Quest
   Browser and tap **Enter VR**.

## Running the tests

Every logic-heavy module (anything that isn't purely "draw a mesh") has
a matching Node test — no browser needed:

```
node test/physics.test.mjs          # vehicle physics numeric stability + spin-out divergence regression
node test/ring-recycler.test.mjs    # static-object pooling math
node test/highway-system.test.mjs   # instanced-mesh pooling + reset(), ground/gantries/billboards, headless
node test/ai-traffic.test.mjs       # traffic pool, lane changes, signals, collision/near-miss, shiftAll()
node test/score-system.test.mjs     # multiplier growth/cap/decay, collision freeze
node test/camera-rig.test.mjs       # camera-faces-car's-front invariant, both modes
node test/input-controller.test.mjs # view/menu toggle rising-edge behavior
node test/spatial-hud.test.mjs      # HUD panels incl. settings, bracket geometry, animations, headless
node test/car-model.test.mjs        # shared car body geometry, paint-color baking, lights
node test/car-settings.test.mjs     # settings navigation/adjustment logic
```

All ten currently pass. Re-run the relevant one after tuning anything.

## Controls

| Input | Desktop | VR |
|---|---|---|
| Steer | A/D or ←/→ | Left thumbstick X |
| Throttle | W or ↑ | Right trigger |
| Brake | S or ↓ | Left trigger |
| Handbrake | Space | Right grip/squeeze |
| Toggle cockpit/chase view | C | Right thumbstick click |
| Open/close settings menu | M | Left grip/squeeze |
| Navigate menu / adjust value | W/S/A/D or arrows (see below) | Same axes as driving |
| Weight-shift lean | — | Physically lean your head left/right |
| Restart after a crash | Hold W/↑ | Hold right trigger |

The settings menu deliberately reuses the driving inputs (throttle/brake
as up/down, steer as left/right) instead of adding a parallel control
scheme — safe because physics and traffic fully pause while the menu is
open, so those inputs aren't also trying to drive at the same time.

## How the gameplay loop works

- **AI traffic** (`AITrafficController.js`): a fixed pool of civilian
  cars spawn ahead of you and respawn once they fall far enough behind
  — same "recycle, don't create/destroy" principle as the highway, but
  via a simple per-car distance check rather than `RingRecycler`,
  because these cars actually move at their own speed instead of
  sitting at a fixed `index * spacing` (see the file's header comment
  for why that distinction matters). Cars cruise in a random lane,
  occasionally signal (front AND rear) and glide into an adjacent lane,
  and their speed is randomized within a range slower than your top
  speed — the whole point is that you can always eventually catch and
  weave past them.
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
- **HUD & settings** (`SpatialHUD.js`): a cyberpunk/terminal-styled
  spatial HUD — speed and score/distance live on two separate
  low-peripheral panels angled slightly inward like a dashboard
  cluster, each framed by REAL 3D corner-bracket geometry sitting just
  in front of its canvas-texture content for genuine depth. A third
  panel is the settings menu (below), and a fourth is the game-over
  summary. Everything animates: a boot-in pop on load/restart/menu-open,
  a looping scanline sweep, a punch-scale pulse on every near-miss, and
  an RGB-split glitch burst the instant you collide. **This had to be
  built as in-world 3D geometry, not a flat HTML overlay** — a regular
  DOM element is invisible inside an actual immersive-vr WebXR session.
- **Car settings** (`CarSettings.js` + the settings panel in
  `SpatialHUD.js`): press M to open a menu with four rows — GRIP
  (Arcade/Sport/Sim presets, live-swapping `VehiclePhysics`'s tire
  friction/cornering stiffness/handbrake force), PAINT (six colors,
  live-rebuilding the car's body geometry), COMFORT (four levels,
  live-setting `CameraRig.comfort`), and VIEW (cockpit/chase, same
  toggle as the C key). All changes apply immediately, not on menu close.

## The environment & car model

- **Ground plane.** There wasn't one before — the skyline was floating
  over pure black void beyond the shoulder. A single large static
  plane (one draw call) now sits underneath everything and re-centers
  under the player each frame.
- **Textured asphalt.** The road surface previously relied entirely on
  flat baked vertex colors; a small tileable noise texture now
  multiplies with those colors for actual close-up grain, without
  adding a second material or draw call.
- **Lane reflectors ("cat's eyes").** Small cyan-emissive dots along
  both internal lane boundaries, spaced like real reflectors. These
  reuse the ROAD's own pool/recycler (a third `InstancedMesh` updated
  in lockstep with the road and guardrails) rather than getting a
  separate pooling system, since their positions are tied 1:1 to
  segment position anyway.
- **Overhead highway gantries.** Sparse landmark structures (every
  ~420m) spanning the road with a canvas-texture route sign, styled to
  match the HUD's cyan/magenta palette. Own `RingRecycler`, two
  `InstancedMesh`es (structure + panel).
- **Roadside billboards.** More frequent (~every 210m), alternating
  sides, glowing neon-ad panels for atmosphere. Same two-mesh pattern
  as the gantries.
- **Car model** (`CarModel.js`, shared by the player and every traffic
  car): lower body + an inset, narrower cabin (tinted "glass" color) +
  a thin roof cap + mirrors + front/rear bumper accents — merged into
  ONE vertex-colored geometry, so the improved silhouette is still a
  single draw call per car body. Headlights/taillights are built the
  same way for both car types now — previously only traffic had them,
  leaving the player's own car (visible in chase view) inconsistently
  dark. Swapping paint color rebuilds this geometry with a new baked
  color; everything else about the mesh is unaffected.

All of the new environment pools follow the same rules already
established for the road/streetlights/skyline: they're covered by
`HighwaySystem.reset()` (so a restart or long-drive rebase doesn't
leave them anchored at the old position — the exact bug class fixed
earlier for the original three pools) and by the update loop's
per-frame recycling.

## Architecture decisions worth knowing about

- **Bicycle-model physics**, power-limited engine, fixed 1/180s
  timestep, VR-comfort-first camera (position-independent "shake" via
  FOV pulse, static cockpit reference) — see the fix log below,
  unchanged since.
- **The entire static highway is ~14 draw calls, however long it
  gets** — road, guardrails, lane reflectors, streetlight fixtures,
  skyline, gantries, and billboards are each one or two
  `THREE.InstancedMesh`es. Only 4 real dynamic `PointLight`s ever
  exist, re-parked at the nearest streetlight stations each frame.
- **Traffic cars are NOT instanced** (each is its own small set of
  meshes — merged body + lights + signals), since they need
  independent colors, states, and animated turn signals per car.
  Merging body+wheels into one geometry (see `CarModel.js`) actually
  *reduced* per-car mesh count versus the original placeholder boxes
  (13 meshes/car → 9) despite the more detailed silhouette. Noted here
  as a real future optimization if the traffic pool ever grows much
  larger: per-instance color via `InstancedMesh.setColorAt` would let
  the whole pool's bodies become one draw call.
- **`RingRecycler` vs. `AITrafficController`'s own recycling:**
  `RingRecycler` is correct for objects whose position IS
  `index * spacing` and never changes otherwise (road, streetlights,
  gantries, billboards). Traffic cars move independently, so recycling
  them needed a different (simpler) trigger — see that file's header
  comment. Same underlying idea, different math, used where each
  actually applies.
- **Every non-visual module is pure and independently tested:**
  `VehiclePhysics`, `RingRecycler`, `ScoreSystem`, and `CarSettings`
  have zero rendering dependency and are unit-tested in plain Node.
  `HighwaySystem`, `AITrafficController`, `SpatialHUD`, and `CarModel`
  do need Three.js (and canvas-texture-generating ones need a
  `document.createElement('canvas')` stub) but are still tested
  headlessly — no WebGL context, no real browser, just the scene-graph
  math.
- **VR comfort shows up throughout:** the chase camera and G-force FOV
  pulse, a HUD kept small and low-peripheral rather than centered, the
  background world fully freezing on collision, and now the settings
  menu also fully pausing the world while open (opening a menu while
  the world keeps moving around you is its own comfort problem).

## Bugs found and fixed during playtesting

Worth knowing about since they explain some non-obvious code:

- **Camera faced backward.** `THREE.Camera` looks down local -Z by
  default; the car's visual front was built at local +Z. `CameraRig.js`
  adds a 180° yaw specifically to the camera's own rotation (not the
  chassis or physics heading) to correct this.
- **Steering was inverted.** Separately from the above — the slip-angle
  math's sign, combined with this project's rotation convention, meant
  steering right yawed the car left. Fixed with a single negation at
  the input-to-physics boundary in `VehiclePhysics.js`, not by touching
  the (correct, self-consistent) slip-angle model itself.
- **Traffic cars, and later streetlight poles and gantry structures,
  were nearly invisible at night.** Every OTHER visible night-scene
  element (building windows, streetlight lamps) uses an emissive
  material; plain dark metal/paint doesn't, and relies entirely on the
  scene's deliberately dim ambient light. Fixed with always-on
  headlights/taillights on every car, and a faint matching neon
  emissive tint on poles/gantry structures — the same root cause found
  three times as more of the environment got built out.
- **Spinning out could rocket speed to 100,000+.** A real numerical
  instability: the rotating-frame coupling terms in `VehiclePhysics.js`
  were integrated with a linear (forward-Euler) approximation, which
  is only conditionally stable — it grows the velocity vector's
  magnitude by a small factor every step once yaw rate is high enough,
  compounding into an exponential blowup within seconds. Fixed by
  applying that coupling as an exact rotation instead (see the step 9
  comment in `VehiclePhysics.js`), plus a hard yawRate safety clamp
  (±8 rad/s — far beyond anything a real spin needs).
- **The cockpit/chase view toggle (and later the settings menu toggle)
  almost never fired.** `input.update()` was being called once per
  PHYSICS SUB-STEP rather than once per RENDERED FRAME. Since multiple
  sub-steps routinely run per frame, a rising-edge toggle flag was
  getting set true and then immediately overwritten back to false
  within the same frame, before `main.js` ever checked it. Fixed by
  sampling input once per frame, before the sub-step loop.
- **The map "glitched" after a restart.** `RingRecycler`-based pools
  only ever recycle FORWARD — no concept of the car teleporting
  backward, which is exactly what a post-collision restart does.
  Without a reset, every pool kept showing geometry anchored near the
  crash site. Added `HighwaySystem.reset(playerZ)` (re-anchors every
  pool, now including the ground/gantries/billboards added later) and
  `CameraRig.resetFollow()`.
- **The car felt too slippery**, and later got a proper settings menu
  instead of just a one-time tuning pass — see GRIP in Car settings above.
- **AI turn signals were barely visible, and only faced forward.**
  Tiny, blinked only 50% of the time, sat almost on top of the
  headlight. Sized up, boosted blink intensity, and added a matching
  REAR pair — the side that actually matters since the player is
  usually catching up to traffic from behind.
- **The world could break down on a very long uninterrupted drive.**
  Two issues: (1) `CameraRig.update()` was allocating 5-9 new
  Vector3/Quaternion/Euler objects every rendered frame, unconditionally
  — real sustained GC pressure. Now preallocated once and reused. (2)
  WebGL's 32-bit float precision erodes at large coordinates. Added a
  "floating origin": past 20,000m, the car/traffic/highway pools all
  shift back toward Z=0 together in the same frame, invisible to the
  player; total distance is tracked separately so it isn't affected.
- **The HUD's corner brackets could flicker or draw in the wrong
  layer.** `renderOrder` was set on each panel's parent Group, but
  Three.js only reads it from the actual mesh being drawn — confirmed
  in the engine source. Fixed by setting it directly on the screen and
  frame meshes, with the frame explicitly after the screen.
- **Streetlight lamps appeared to float with no visible pole.** Same
  "plain dark material against black sky" issue as the traffic cars,
  applying to the pole geometry specifically. Fixed with a faint cyan
  neon emissive tint.

## Key tunables

**`VehiclePhysics.js`** — now primarily adjusted live via the in-game
settings menu (GRIP row), but these remain the underlying constructor
defaults (SPORT preset):

| Variable | Default | Effect |
|---|---|---|
| `tireFriction` | 1.35 | Global grip ceiling — SIM preset drops to 1.05, ARCADE raises to 1.6 |
| `corneringStiffnessFront` / `Rear` | 100000 / 118000 N/rad | Grip sharpness per axle — rear stiffer biases toward stable understeer |
| `handbrakeForceMax` | 12000 N | Rear-axle lock force, scaled per grip preset so it still overpowers rear traction for an intentional slide |
| `engineForceMax` / `enginePowerMax` | 9200 N / 130000 W | Launch torque cap / top-speed power cap |
| `maxSteerAngle` / `steerRate` | 34° / 3.2 rad/s | Full lock angle / how fast it gets there |
| `leanAssistStrength` | 0.15 | VR-specific: physically leaning your head nudges yaw slightly |

**`CameraRig.comfort`** — now set live via the settings menu (COMFORT
row: 0 / 0.33 / 0.66 / 1.0) instead of only a constructor option.

**`HighwaySystem.js`** (new environment options, all with sane defaults):

| Variable | Default | Effect |
|---|---|---|
| `gantrySpacing` / `gantrySlots` | 420m / 4 | Overhead sign frequency and pool depth |
| `billboardSpacing` / `billboardSlots` | 210m / 8 | Billboard frequency and pool depth |
| `billboardDistance` | roadWidth/2+9 | How far off the road billboards sit |

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

**`CarSettings.js`** — edit `GRIP_PRESETS` / `PAINT_COLORS` /
`COMFORT_LEVELS` directly to add or change menu options; the panel and
navigation logic both read these lists rather than hardcoding choices.

## Roadmap

1. ~~Vehicle physics + input~~
2. ~~Physics-driven camera (cockpit + chase)~~
3. ~~Endless highway (road, streetlights, skyline)~~
4. ~~AI traffic controller (pooling, lane changes, turn signals)~~
5. ~~Score/UI + collision + restart~~
6. ~~Spatial cyberpunk HUD with animations~~
7. ~~Detailed car model, textured/detailed environment, car settings menu~~

All originally requested systems are in place, plus a full visual and
settings pass. From here it's further polish: gentle road curvature,
a world-locked (dashboard-mounted) HUD variant for maximum comfort,
per-instance traffic-color rendering (see the draw-call note above),
and engine/tire audio.
