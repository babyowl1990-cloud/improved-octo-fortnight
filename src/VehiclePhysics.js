/**
 * VehiclePhysics.js
 * ------------------------------------------------------------------
 * A semi-realistic car physics model using a "bicycle model" (single
 * front wheel + single rear wheel representing each axle). This is
 * the standard middle ground used across indie/AA racing games: it's
 * cheap enough to run every frame in VR (must hold 90fps), but it
 * genuinely models slip, weight transfer, and the friction circle —
 * so throttle/brake/steering interact the way they do in a real car
 * instead of just adding velocity in a direction.
 *
 * Deliberately has ZERO dependency on Three.js or any renderer. It
 * only deals in plain numbers (meters, kg, radians, seconds). A
 * separate adapter (see main.js) copies its output state onto a
 * THREE.Object3D each frame. This keeps the physics testable in
 * isolation (see test/physics.test.mjs) and reusable if the
 * rendering layer ever changes.
 *
 * COORDINATE CONVENTIONS
 *  - World space: +X right, +Z forward-at-heading-0, +Y up (matches
 *    Three.js's default right-handed system with -Z as "forward").
 *  - Vehicle-local space: +x = forward (in the direction the car is
 *    pointed), +y = left. heading = 0 means facing +Z in world space.
 *  - Angles in radians. Speeds in m/s internally; speedKmh/speedMph
 *    are provided as convenience read-outs for the UI.
 * ------------------------------------------------------------------
 */

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const GRAVITY = 9.81; // m/s^2

export class VehiclePhysics {
  /**
   * @param {object} config - all fields optional; sane defaults model
   *   a mid-size RWD sport sedan. Override per-vehicle for variety.
   */
  constructor(config = {}) {
    // ---------------- Mass & geometry ----------------
    this.mass = config.mass ?? 1350;              // kg, curb weight
    this.wheelbase = config.wheelbase ?? 2.65;     // m, front axle to rear axle
    this.cgToFront = config.cgToFront ?? 1.27;     // m, CG to front axle ("a")
    this.cgToRear = this.wheelbase - this.cgToFront; // m, CG to rear axle ("b")
    this.trackWidth = config.trackWidth ?? 1.55;   // m, left wheel to right wheel
    this.cgHeight = config.cgHeight ?? 0.50;       // m, height of center of gravity
    this.yawInertia = config.yawInertia ??          // kg*m^2, resistance to spinning (Izz)
      this.mass * (this.wheelbase * this.wheelbase) / 12 * 1.4; // reasonable estimate if not given

    // ---------------- Tire model ----------------
    // Cornering stiffness: how hard each axle resists slip, in N per
    // radian of slip angle, BEFORE the friction-circle clamp below.
    // Higher = sharper turn-in, lower = softer/more forgiving.
    this.corneringStiffnessFront = config.corneringStiffnessFront ?? 80000;
    this.corneringStiffnessRear = config.corneringStiffnessRear ?? 92000; // stiffer rear = less prone to oversteer
    this.tireFriction = config.tireFriction ?? 1.05; // ~1.0 = dry asphalt, ~0.5 = wet, ~0.25 = ice

    // ---------------- Powertrain & brakes ----------------
    // Two-stage engine model: at low speed the wheels are TORQUE-limited
    // (engineForceMax caps launch force so 0-60 doesn't wheelspin-teleport);
    // at high speed real engines are POWER-limited (force falls off as
    // 1/speed because power = force * speed is roughly constant near
    // redline). Without this second cap, a constant-force model with a
    // plausible drag coefficient reaches unrealistic 400+ km/h top speeds.
    this.engineForceMax = config.engineForceMax ?? 9200;   // N at the wheels, launch cap
    this.enginePowerMax = config.enginePowerMax ?? 130000; // W (~174 hp), high-speed cap
    this.brakeForceMax = config.brakeForceMax ?? 15500;    // N, full brake pedal
    this.handbrakeForceMax = config.handbrakeForceMax ?? 8500; // N, rear-axle-only lock force
    this.rollingResistanceCoeff = config.rollingResistanceCoeff ?? 0.015;
    this.dragCoeff = config.dragCoeff ?? 0.40; // lumped aerodynamic drag constant (N per (m/s)^2), ~0.5*air_density*Cd*frontalArea

    // ---------------- Steering ----------------
    this.maxSteerAngle = config.maxSteerAngle ?? degToRad(34); // rad, full lock
    this.steerRate = config.steerRate ?? 3.2; // rad/sec — caps how fast the wheel can turn
    // (this is what makes steering "progressive" rather than snapping
    // instantly to the input's full deflection)

    // ---------------- Visual response tuning (body roll/pitch) ----------------
    this.maxRollAngle = config.maxRollAngle ?? degToRad(7);
    this.maxPitchAngle = config.maxPitchAngle ?? degToRad(4);
    this.rollResponse = config.rollResponse ?? 0.10;   // 0..1, smoothing toward target roll/pitch
    this.gSmoothing = config.gSmoothing ?? 0.18;        // 0..1, smoothing of raw accel into "felt" G

    // ---------------- Optional VR weight-shift assist ----------------
    // Driven by head/torso lean read from the input controller. Purely
    // a subtle steering/grip nudge layered on top of the real model —
    // set to 0 to disable if you want pure wheel-only steering.
    this.leanAssistStrength = config.leanAssistStrength ?? 0.15;

    // ---------------- State (read/write each frame) ----------------
    this.position = { x: 0, y: 0, z: 0 };
    this.heading = 0;      // yaw, radians, 0 = facing +Z
    this.vx = 0;           // forward speed, m/s, vehicle-local
    this.vy = 0;           // lateral speed, m/s, vehicle-local (+ = sliding left)
    this.yawRate = 0;      // rad/s

    this.currentSteerAngle = 0; // rad, the *actual* wheel angle after rate limiting

    // Smoothed values consumed by the camera/chassis-mesh system:
    this.longitudinalG = 0; // + = accelerating, - = braking, in units of g
    this.lateralG = 0;      // + = cornering right-hand load transfer, in units of g
    this.rollAngle = 0;     // rad, visual body roll (banks opposite the turn's lateral G)
    this.pitchAngle = 0;    // rad, visual dive (braking) / squat (accel)

    // Convenience read-outs for the UI layer:
    this.speedMs = 0;
    this.speedKmh = 0;
    this.speedMph = 0;

    // Debug/tuning read-outs (handy while tuning the model):
    this.slipAngleFront = 0;
    this.slipAngleRear = 0;
    this.frontLoad = 0;
    this.rearLoad = 0;

    /**
     * Inputs — set these from your input controller BEFORE calling
     * update(dt) each frame. Values are normalized:
     *   steer:      -1 (full left) .. +1 (full right)
     *   throttle:    0 .. 1
     *   brake:       0 .. 1
     *   handbrake:   boolean
     *   leanAmount: -1 (leaning left) .. +1 (leaning right), optional
     */
    this.input = { steer: 0, throttle: 0, brake: 0, handbrake: false, leanAmount: 0 };
  }

  /**
   * Advances the simulation by dt seconds. Call this once per frame
   * (or on a fixed timestep accumulator — recommended for VR, see
   * main.js) with fresh `this.input` values already set.
   */
  update(dt) {
    // Clamp dt so a hitch (tab switch, GC pause) can't blow up the
    // integration with a huge single step.
    dt = clamp(dt, 0, 1 / 30);
    if (dt === 0) return;

    // ---- 1. Progressive steering: rate-limit toward the target ----
    const targetSteer = clamp(this.input.steer, -1, 1) * this.maxSteerAngle;
    const maxStep = this.steerRate * dt;
    this.currentSteerAngle += clamp(targetSteer - this.currentSteerAngle, -maxStep, maxStep);

    // ---- 2. Slip angles (bicycle model) ----
    // vxSafe avoids atan2's low-speed instability (a stationary car
    // otherwise reports huge, meaningless slip angles from tiny vy).
    const vxSafe = Math.sign(this.vx || 1) * Math.max(Math.abs(this.vx), 0.6);
    const alphaFront = Math.atan2(this.vy + this.yawRate * this.cgToFront, vxSafe) - this.currentSteerAngle;
    const alphaRear = Math.atan2(this.vy - this.yawRate * this.cgToRear, vxSafe);
    this.slipAngleFront = alphaFront;
    this.slipAngleRear = alphaRear;

    // ---- 3. Longitudinal force request (throttle/brake/handbrake) ----
    const throttle = clamp(this.input.throttle, 0, 1);
    const brake = clamp(this.input.brake, 0, 1);
    const movingForward = this.vx >= 0;

    // Power cap only meaningfully bites once rolling — at a standstill
    // (speedForPower clamped to 1 m/s) the torque cap alone governs launch.
    const speedForPower = Math.max(Math.abs(this.vx), 1);
    const powerLimitedForce = this.enginePowerMax / speedForPower;
    let driveForce = throttle * Math.min(this.engineForceMax, powerLimitedForce);
    let brakeForce = brake * this.brakeForceMax + (this.input.handbrake ? this.handbrakeForceMax : 0);
    // Braking always opposes current motion, not a fixed direction:
    brakeForce *= movingForward ? -1 : 1;

    const speed = Math.hypot(this.vx, this.vy);
    const dragForce = this.dragCoeff * speed * speed * Math.sign(this.vx || 0);
    const rollingResForce = this.rollingResistanceCoeff * this.mass * GRAVITY * Math.sign(this.vx || 0);

    const longForceIntent = driveForce + brakeForce - dragForce - rollingResForce;

    // ---- 4. Weight transfer (longitudinal + lateral) ----
    // Uses last frame's smoothed G so this frame's load distribution
    // reacts to what the car is *actually* doing, not a guess — this
    // is what produces "nose dives under braking, squats on launch,
    // and loads the outside tires in a corner" without simulating a
    // full suspension.
    const staticFrontLoad = this.mass * GRAVITY * (this.cgToRear / this.wheelbase);
    const staticRearLoad = this.mass * GRAVITY * (this.cgToFront / this.wheelbase);
    const longTransfer = (this.mass * this.longitudinalG * GRAVITY * this.cgHeight) / this.wheelbase;
    const latTransferMag = Math.abs((this.mass * this.lateralG * GRAVITY * this.cgHeight) / this.trackWidth);

    // Longitudinal: accelerating shifts load to the rear (reduces front);
    // braking (negative longitudinalG) shifts it to the front.
    let frontLoad = staticFrontLoad - longTransfer;
    let rearLoad = staticRearLoad + longTransfer;

    // Lateral transfer reduces grip on BOTH axles' inside tires, which
    // (summed across the axle) nets out as a small total-grip loss —
    // approximate that here as an axle-load "haircut" proportional to
    // how hard we're cornering, rather than modeling all 4 tires.
    const latGripLoss = 1 - clamp(latTransferMag / (this.mass * GRAVITY), 0, 0.35);
    frontLoad = Math.max(frontLoad, staticFrontLoad * 0.15) * latGripLoss;
    rearLoad = Math.max(rearLoad, staticRearLoad * 0.15) * latGripLoss;
    this.frontLoad = frontLoad;
    this.rearLoad = rearLoad;

    // ---- 5. Lateral tire forces, clamped to the friction circle ----
    let fyFront = -this.corneringStiffnessFront * alphaFront;
    let fyRear = -this.corneringStiffnessRear * alphaRear;
    const maxFyFront = this.tireFriction * frontLoad;
    const maxFyRear = this.tireFriction * rearLoad;
    fyFront = clamp(fyFront, -maxFyFront, maxFyFront);
    fyRear = clamp(fyRear, -maxFyRear, maxFyRear);

    // ---- 6. Longitudinal force, clamped to remaining available traction ----
    const maxFx = this.tireFriction * (frontLoad + rearLoad);
    const fx = clamp(longForceIntent, -maxFx, maxFx);

    // ---- 7. Sum forces -> accelerations (vehicle-local frame) ----
    const ax = (fx - fyFront * Math.sin(this.currentSteerAngle)) / this.mass + this.yawRate * this.vy;
    const ay = (fyFront * Math.cos(this.currentSteerAngle) + fyRear) / this.mass - this.yawRate * this.vx;
    const yawTorque = this.cgToFront * fyFront * Math.cos(this.currentSteerAngle) - this.cgToRear * fyRear;
    const yawAccel = yawTorque / this.yawInertia;

    // ---- 8. Optional VR lean assist ----
    // A gentle nudge to yaw rate from the driver physically leaning
    // into a turn — NOT a substitute for steering, just a "weight
    // shift" flavor input some VR racers use. Zero this out via
    // config.leanAssistStrength = 0 if you'd rather not have it.
    const leanYawNudge = clamp(this.input.leanAmount, -1, 1) * this.leanAssistStrength * (speed / 20);

    // ---- 9. Integrate ----
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.yawRate += (yawAccel + leanYawNudge) * dt;
    this.heading += this.yawRate * dt;

    const worldVx = this.vx * Math.sin(this.heading) + this.vy * Math.cos(this.heading);
    const worldVz = this.vx * Math.cos(this.heading) - this.vy * Math.sin(this.heading);
    this.position.x += worldVx * dt;
    this.position.z += worldVz * dt;

    // ---- 10. Smoothed G-forces (feed the camera + body roll/pitch) ----
    this.longitudinalG = lerp(this.longitudinalG, ax / GRAVITY, this.gSmoothing);
    this.lateralG = lerp(this.lateralG, ay / GRAVITY, this.gSmoothing);

    const targetRoll = clamp(-this.lateralG * 0.12, -this.maxRollAngle, this.maxRollAngle);
    const targetPitch = clamp(-this.longitudinalG * 0.10, -this.maxPitchAngle, this.maxPitchAngle);
    this.rollAngle = lerp(this.rollAngle, targetRoll, this.rollResponse);
    this.pitchAngle = lerp(this.pitchAngle, targetPitch, this.rollResponse);

    // ---- 11. UI read-outs ----
    this.speedMs = speed;
    this.speedKmh = speed * 3.6;
    this.speedMph = speed * 2.236936;
  }

  /** Snaps the car back to a clean stationary state at the given pose. */
  reset(x = 0, z = 0, heading = 0) {
    this.position.x = x; this.position.y = 0; this.position.z = z;
    this.heading = heading;
    this.vx = this.vy = this.yawRate = 0;
    this.currentSteerAngle = 0;
    this.longitudinalG = this.lateralG = this.rollAngle = this.pitchAngle = 0;
    this.speedMs = this.speedKmh = this.speedMph = 0;
  }
}

function degToRad(d) {
  return (d * Math.PI) / 180;
}
