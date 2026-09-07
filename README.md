# Highway VR Racer — build scaffold

A VR-only highway cruising / traffic-weaving game, built in stages. This
drop covers **System 2 (Vehicle Physics + Camera)** and **System 1
(Endless Highway)** — drive around a lit, multi-lane night highway and
switch between cockpit and chase views.

## Folder structure

```
highway-vr-racer/
├─ index.html               # entry point — import map + mounts the VR button
├─ src/
│  ├─ VehiclePhysics.js      # pure-JS bicycle-model physics engine (no renderer dependency)
│  ├─ VRInputController.js   # WebXR controller + keyboard-fallback input mapping
│  ├─ CameraRig.js           # cockpit/chase camera, G-force/speed reactive FOV, VR-comfort-first
│  ├─ HighwaySystem.js       # endless multi-lane road, streetlights, skyline — all instanced/pooled
│  ├─ RingRecycler.js        # shared pooling/recycling math (road, lights, and later AI traffic)
│  └─ main.js                # wires it all together, fixed-timestep loop
├─ vendor/three/             # Three.js r0.185 + VRButton + BufferGeometryUtils, vendored — no CDN
└─ test/
   ├─ physics.test.mjs        # physics numeric smoke test
   ├─ ring-recycler.test.mjs  # pooling logic smoke test
   └─ highway-system.test.mjs # instanced-mesh pooling smoke test (headless, no WebGL)
```

No build step. `npm`/`node_modules` were only ever used transiently to
pull exact Three.js build files during scaffolding — not required to run
the game, and not included in this zip.

## Running it

1. **Serve the folder** (WebXR needs a secure context; plain
   `http://localhost` counts, no TLS cert needed):
   ```
   npx serve .
   ```
   or `python3 -m http.server 8080`
2. **Desktop first:** open the printed URL in Chrome/Edge, drive with
   WASD/arrows, press **C** to swap cockpit/chase view. Fastest way to
   tune physics/camera feel without a headset round-trip. The
   "Immersive Web Emulator" Chrome extension can simulate a full XR
   session (headset pose + controllers) if you want to test XR-specific
   input without hardware.
3. **Real headset (e.g. Quest):** `adb reverse tcp:8080 tcp:8080` after
   plugging in via USB, then open `http://localhost:8080` in the Quest
   Browser and tap **Enter VR**.
4. **Verify the logic-heavy parts anytime, no browser needed:**
   ```
   node test/physics.test.mjs
   node test/ring-recycler.test.mjs
   node test/highway-system.test.mjs
   ```

## Controls

| Input | Desktop | VR |
|---|---|---|
| Steer | A/D or ←/→ | Left thumbstick X |
| Throttle | W or ↑ | Right trigger |
| Brake | S or ↓ | Left trigger |
| Handbrake | Space | Right grip/squeeze |
| Toggle cockpit/chase view | C | Right thumbstick click |
| Weight-shift lean | — | Physically lean your head left/right |

## Architecture decisions worth knowing about

- **Bicycle-model physics**, power-limited engine, fixed 1/180s
  timestep — see the previous drop's notes, unchanged here.
- **Camera comfort is a first-class design constraint, not an
  afterthought.** "Shake" never moves the camera's *position* — only
  its FOV pulses slightly with G-force. Moving a VR camera out of sync
  with the player's real head tracking is the actual mechanism behind
  simulator sickness, so position-shake (the normal flat-screen-game
  technique) was deliberately avoided. The chase camera also stays
  upright (heading-only rotation, no roll/pitch) for the same reason.
  `CameraRig`'s `comfort` option (0..1) scales all of this down to
  fully off for sensitive players.
- **Static cockpit reference (dashboard/wheel silhouette).** A fixed
  foreground object in the cockpit view is one of the best-documented
  ways to reduce VR motion sickness — it's currently a placeholder box
  + torus, swap for a real interior model whenever you like.
- **The entire highway is ~8 draw calls, however long it gets.** Road
  surface, guardrails, streetlight poles/lamps, and skyline buildings
  are each a single `THREE.InstancedMesh` covering the whole pool —
  whether the pool holds 14 segments or 400 makes no difference to draw
  call count. Only a small fixed pool of 4 real `THREE.PointLight`s
  exists at any time; they're re-parked at the nearest streetlight
  stations each frame instead of ever multiplying. Real-time lights are
  one of the most expensive things you can add to a WebXR scene
  (rendered twice, once per eye) so this matters more here than in a
  typical desktop game.
- **`RingRecycler` is factored out on purpose.** The pooling math (a
  fixed window of logical indices that slides forward, recycling the
  furthest-behind slot to become the furthest-ahead one) is identical
  whether you're pooling road segments, streetlights, or — next —
  traffic cars. Built once, unit-tested once, reused three times.
- **Straight highway, no curvature yet.** Satisfies "endless" and
  "object-pooled" as asked; gentle procedural curves are a natural next
  step and wouldn't require changing how lanes/traffic/camera talk to
  the highway (they already go through `laneCenterX()`, not raw world X).

## Key tunables

**`VehiclePhysics.js`** (unchanged from the previous drop — mass, cornering
stiffness, engine force/power caps, steering rate, lean-assist strength).

**`CameraRig.js`**:

| Variable | Default | Effect |
|---|---|---|
| `comfort` | 1.0 | Master 0..1 scale on FOV-kick + G-force pulse. 0 = fully static, most comfortable |
| `seatOffset` / `chaseOffset` | (0, 1.05, -0.35) / (0, 2.2, 6.5) | Cockpit seat position / chase camera position relative to the car |
| `chaseFollowSharpness` | 4.0 | How snappily the chase cam catches up to the car (higher = tighter follow) |
| `maxFovKick` / `speedForMaxFov` | 10° / 60 m/s | How much FOV widens as speed increases, and the speed it maxes out at |

**`HighwaySystem.js`**:

| Variable | Default | Effect |
|---|---|---|
| `laneCount` / `laneWidth` | 3 / 3.6m | Number and width of lanes (real-world highway scale) |
| `segmentLength` / `segmentSlots` | 50m / 14 | Road tile size and pool depth — increase slots for a longer visible draw distance |
| `lightSpacing` / `realLightCount` | 45m / 4 | Streetlight station spacing / size of the real dynamic-light pool |
| `buildingSpacing` / `buildingDistance` | 65m / roadWidth/2+34 | Skyline density and how far off the road it sits |

## Roadmap

1. ~~Vehicle physics + input~~
2. ~~Physics-driven camera (cockpit + chase)~~
3. ~~Endless highway (road, streetlights, skyline)~~ ← this drop adds this + #2
4. **AI traffic controller** — pooled civilian vehicles (reusing
   `RingRecycler`), lane logic, turn signals, the actual "weave through
   traffic" gameplay loop
5. **Score/UI + game-over** — speed/distance HUD, near-miss multiplier,
   collision → summary screen

AI traffic is next up unless you'd rather jump to score/UI first.
