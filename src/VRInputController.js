/**
 * VRInputController.js
 * ------------------------------------------------------------------
 * Reads driving input from WebXR motion controllers and turns it into
 * the normalized {steer, throttle, brake, handbrake, leanAmount}
 * shape that VehiclePhysics.input expects.
 *
 * Also runs a KEYBOARD FALLBACK (arrow keys / WASD + space) that is
 * always active. This isn't for shipping — it's so you can tune the
 * physics on a flat desktop screen without putting a headset on for
 * every single iteration. It's automatically ignored the moment a
 * real controller axis/trigger is touched.
 *
 * CONTROL MAPPING (xr-standard gamepad profile — the mapping the
 * WebXR spec asks conformant runtimes to expose controllers as):
 *   Left controller:
 *     - thumbstick X (axes[2])  -> steering
 *     - trigger (buttons[0])    -> brake
 *   Right controller:
 *     - trigger (buttons[0])       -> throttle
 *     - squeeze/grip (buttons[1])  -> handbrake
 *     - thumbstick click (buttons[3]) -> toggle cockpit/chase camera
 *   Head lean:
 *     - lateral head offset from a calibrated neutral -> leanAmount
 *   Keyboard fallback also maps 'C' to the camera-view toggle.
 *
 * NOTE ON HARDWARE VARIATION: 'xr-standard' is the spec-mandated
 * mapping, but real controllers (Quest Touch, Index "Knuckles",
 * WMR wands, PSVR2 Sense) occasionally expose extra/reordered
 * buttons. If a specific headset's brake/throttle feel swapped or
 * dead, that's the first thing to check — remap the constants below,
 * they're deliberately pulled out instead of buried in the method.
 * ------------------------------------------------------------------
 */

// --- xr-standard axis/button indices (see note above) ---
const AXIS_THUMBSTICK_X = 2;
const BUTTON_TRIGGER = 0;
const BUTTON_SQUEEZE = 1;
const BUTTON_THUMBSTICK_CLICK = 3; // right controller: toggles cockpit/chase camera

// Response curves — tune feel without touching the read/parsing logic.
const STEER_DEADZONE = 0.08;
const STEER_EXPONENT = 1.6;   // >1 = softer near center, sharper near full lock
const LEAN_DEADZONE_M = 0.03; // meters of head offset before lean registers at all
const LEAN_RANGE_M = 0.35;    // meters of head offset that maps to full +/-1 lean

function applyDeadzoneAndCurve(value, deadzone, exponent) {
  const sign = Math.sign(value);
  const mag = Math.max(0, (Math.abs(value) - deadzone) / (1 - deadzone));
  return sign * Math.pow(Math.min(mag, 1), exponent);
}

export class VRInputController {
  /** @param {import('three').WebGLRenderer} renderer - needed to read the active XR session/camera */
  constructor(renderer) {
    this.renderer = renderer;
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, leanAmount: 0, viewToggled: false };

    // Rising-edge tracking for the camera view-toggle button, so a held
    // button doesn't flip the view every single frame.
    this._viewButtonWasDown = false;

    // Head-lean calibration: captured on the first XR frame, or
    // whenever recenterLean() is called (bind that to a menu button).
    this._leanNeutralX = null;

    // ---- Keyboard fallback (desktop tuning only) ----
    this._keys = Object.create(null);
    this._onKeyDown = (e) => { this._keys[e.code] = true; };
    this._onKeyUp = (e) => { this._keys[e.code] = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  /** Call once per frame before reading `.state`. */
  update() {
    const session = this.renderer.xr.getSession?.();
    const xrState = session ? this._readXRControllers(session) : null;
    const keyState = this._readKeyboard();

    // Prefer real XR controller input; fall back to keyboard for any
    // axis the controllers aren't actively driving. This lets you
    // test on desktop pre-headset and switch to VR with no code change.
    this.state.steer = xrState?.steerActive ? xrState.steer : keyState.steer;
    this.state.throttle = xrState?.throttleActive ? xrState.throttle : keyState.throttle;
    this.state.brake = xrState?.brakeActive ? xrState.brake : keyState.brake;
    this.state.handbrake = (xrState?.handbrake ?? false) || keyState.handbrake;
    this.state.leanAmount = xrState ? xrState.leanAmount : 0;

    // Rising-edge view toggle: true for exactly one update() call per
    // press, from either the keyboard or the XR thumbstick click.
    const viewButtonDown = keyState.viewButtonDown || (xrState?.viewButtonDown ?? false);
    this.state.viewToggled = viewButtonDown && !this._viewButtonWasDown;
    this._viewButtonWasDown = viewButtonDown;

    return this.state;
  }

  /** Re-zeroes the head-lean neutral position to wherever the player's head is right now. */
  recenterLean() {
    this._leanNeutralX = null; // lazily recalculated next frame in _readXRControllers
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  // ------------------------------------------------------------------
  _readXRControllers(session) {
    let steer = 0, throttle = 0, brake = 0, handbrake = false, viewButtonDown = false;
    let steerActive = false, throttleActive = false, brakeActive = false;

    for (const source of session.inputSources) {
      const gp = source.gamepad;
      if (!gp) continue;

      if (source.handedness === 'left') {
        const rawSteer = gp.axes[AXIS_THUMBSTICK_X] ?? 0;
        if (Math.abs(rawSteer) > STEER_DEADZONE) {
          steer = applyDeadzoneAndCurve(rawSteer, STEER_DEADZONE, STEER_EXPONENT);
          steerActive = true;
        }
        const brakeTrigger = gp.buttons[BUTTON_TRIGGER]?.value ?? 0;
        if (brakeTrigger > 0.02) { brake = brakeTrigger; brakeActive = true; }
      }

      if (source.handedness === 'right') {
        const throttleTrigger = gp.buttons[BUTTON_TRIGGER]?.value ?? 0;
        if (throttleTrigger > 0.02) { throttle = throttleTrigger; throttleActive = true; }
        if (gp.buttons[BUTTON_SQUEEZE]?.pressed) handbrake = true;
        if (gp.buttons[BUTTON_THUMBSTICK_CLICK]?.pressed) viewButtonDown = true;
      }
    }

    const leanAmount = this._computeHeadLean();
    return { steer, throttle, brake, handbrake, steerActive, throttleActive, brakeActive, leanAmount, viewButtonDown };
  }

  _computeHeadLean() {
    const camera = this.renderer.xr.getCamera?.();
    if (!camera) return 0;
    const headX = camera.position.x;
    if (this._leanNeutralX === null) {
      this._leanNeutralX = headX; // calibrate on first read after (re)start/recenter
      return 0;
    }
    const offset = headX - this._leanNeutralX;
    return applyDeadzoneAndCurve(
      Math.max(-1, Math.min(1, offset / LEAN_RANGE_M)),
      LEAN_DEADZONE_M / LEAN_RANGE_M,
      1.0
    );
  }

  _readKeyboard() {
    const k = this._keys;
    const left = k['ArrowLeft'] || k['KeyA'];
    const right = k['ArrowRight'] || k['KeyD'];
    return {
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      throttle: (k['ArrowUp'] || k['KeyW']) ? 1 : 0,
      brake: (k['ArrowDown'] || k['KeyS']) ? 1 : 0,
      handbrake: !!k['Space'],
      viewButtonDown: !!k['KeyC'],
    };
  }
}
