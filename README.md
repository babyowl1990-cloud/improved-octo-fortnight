# Highway VR Racer — build scaffold (System 2: Vehicle Physics)

A VR-only highway cruising / traffic-weaving game, built in stages. This
drop contains **System 2 (Vehicle Physics + Input)** plus a minimal test
harness so you can drive the model around before the highway and traffic
systems exist.

## Folder structure

```
highway-vr-racer/
├─ index.html              # entry point — serves the import map + mounts the VR button
├─ src/
│  ├─ VehiclePhysics.js     # pure-JS bicycle-model physics engine (no renderer dependency)
│  ├─ VRInputController.js  # WebXR controller + keyboard-fallback input mapping
│  └─ main.js               # Three.js scene, fixed-timestep loop, cockpit camera rig
├─ vendor/three/            # Three.js r0.185, vendored locally — no CDN, works offline
└─ test/
   └─ physics.test.mjs      # numeric smoke test for the physics core (`node test/physics.test.mjs`)
```

No build step, no bundler, no `npm install` needed to *run* it — everything
the browser loads is either your own source or already vendored in
`/vendor`. `npm`/`node_modules` in this folder were only used to pull the
exact Three.js build files during scaffolding; they're not required at
runtime and can be deleted.

## Running it

1. **Serve the folder** (WebXR requires a "secure context" — `file://`
   won't work, but plain `http://localhost` is treated as secure, so no
   TLS cert is needed for local testing):
   ```
   npx serve .
   ```
   or `python3 -m http.server 8080`

2. **Desktop, no headset yet:** open `http://localhost:3000` (or whatever
   port your server prints) in Chrome/Edge and use **WASD or the arrow
   keys** to drive. This is the fastest way to tune the physics — no
   headset round-trip per change. Install the **"Immersive Web Emulator"**
   Chrome extension if you want to simulate an XR session (controllers +
   headset pose) without owning hardware.

3. **On an actual headset (e.g. Quest):**
   - Plug the headset into your dev machine via USB and run
     `adb reverse tcp:8080 tcp:8080` (swap 8080 for whatever port you
     served on). This makes the headset's `localhost:8080` tunnel to your
     PC — no HTTPS certificate needed, since it's still "localhost" from
     the headset browser's point of view.
   - Open the Quest Browser and navigate to `http://localhost:8080`.
   - Tap **Enter VR**.

4. **Verify the physics core independently** (no browser needed):
   ```
   node test/physics.test.mjs
   ```
   This runs straight-line acceleration, braking, cornering, and
   handbrake-oversteer checks and fails loudly on NaN/instability. Re-run
   it after any tuning pass on `VehiclePhysics.js`.

## Controls (current scaffold)

| Input | Desktop (keyboard) | VR |
|---|---|---|
| Steer | A/D or ←/→ | Left thumbstick X |
| Throttle | W or ↑ | Right trigger |
| Brake | S or ↓ | Left trigger |
| Handbrake | Space | Right grip/squeeze |
| Weight-shift lean | — | Physically lean your head left/right |

## Architecture decisions worth knowing about

- **Bicycle model, not 4-wheel raycast suspension.** Two axles (front/rear)
  instead of four independently-suspended wheels. This is the standard
  middle ground for racing games that need to run physics every frame in
  VR (90Hz+) — it genuinely models slip angle, weight transfer, and the
  friction circle, which is what makes it feel like a car losing grip
  rather than an arcade kart, without the cost of a full suspension sim.
- **Power-limited engine force.** Constant throttle force alone (with a
  believable drag coefficient) produces unrealistic 400+ km/h top speeds,
  because real engines make less force as speed rises (power = force ×
  speed is roughly capped). `engineForceMax` limits low-speed launch
  torque; `enginePowerMax` limits high-speed force. Default tune settles
  around ~235 km/h top speed with a ~5s 0-60mph.
- **Fixed 1/180s physics timestep with an accumulator**, decoupled from
  the render/XR frame rate (`main.js`). Headsets vary refresh rate
  (72/90/120Hz) — stepping physics directly off `rAF` delta would make
  tire grip and weight transfer subtly refresh-rate-dependent.
- **Vendored Three.js, no CDN.** `vendor/three` is a direct copy of the
  npm package's build output, referenced via a relative import map in
  `index.html`. Fully offline-capable, matching how the GLTF viewer and
  other tools were built.
- **Physics module has zero rendering dependencies.** `VehiclePhysics.js`
  only imports nothing — it's plain numbers in, plain numbers out. That's
  what let it be unit-tested in Node with no browser/WebGL context at all.

## Key tunables (all in `VehiclePhysics.js` constructor)

| Variable | Default | Effect |
|---|---|---|
| `mass` | 1350 kg | Overall inertia — heavier = slower accel, more momentum through corners |
| `wheelbase` / `cgHeight` | 2.65 m / 0.50 m | Geometry driving weight-transfer magnitude |
| `corneringStiffnessFront/Rear` | 80000 / 92000 N/rad | Grip sharpness per axle — rear > front biases toward understeer (stable, forgiving) |
| `tireFriction` | 1.05 | Global grip ceiling — drop to ~0.5 for a "wet road" mode later |
| `engineForceMax` / `enginePowerMax` | 9200 N / 130000 W | Launch torque cap / top-speed power cap |
| `maxSteerAngle` / `steerRate` | 34° / 3.2 rad/s | Full-lock angle and how fast the wheel can turn (the "progressive" part of progressive steering) |
| `leanAssistStrength` | 0.15 | How much physically leaning your head nudges yaw — set to 0 to disable |

## Roadmap (not yet built)

1. ~~Vehicle physics + input~~ ← this drop
2. **Endless highway system** — object-pooled multi-lane road segments,
   night urban-expressway look, streetlight pooling
3. **AI traffic controller** — pooled civilian vehicles, lane logic, turn
   signals, the actual "weave through traffic" gameplay loop
4. **Score/UI + game-over** — speed/distance HUD, near-miss multiplier,
   collision → summary screen

Say which one you want next and I'll build it against this same car/
physics foundation.
