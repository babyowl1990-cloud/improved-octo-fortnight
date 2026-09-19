/**
 * CarSettings.js
 * ------------------------------------------------------------------
 * Pure state for the in-car settings menu — deliberately has zero
 * rendering dependency (same philosophy as VehiclePhysics.js and
 * ScoreSystem.js). Holds which row is selected and each row's current
 * value; main.js reads `.grip` / `.paint` / `.comfort` / `.view` and
 * pushes them into VehiclePhysics/CameraRig/the car's paint whenever
 * they change. SpatialHUD only reads this to draw the panel.
 * ------------------------------------------------------------------
 */

// Grip preset values were chosen to bracket the tuning history of this
// project: SIM matches the original from-first-principles defaults
// (before playtesting found the car too slippery), SPORT matches
// where that tuning ended up after the grip pass, ARCADE goes further
// for players who want maximum stick.
export const GRIP_PRESETS = [
  { name: 'ARCADE', tireFriction: 1.6, corneringStiffnessFront: 115000, corneringStiffnessRear: 132000, handbrakeForceMax: 13000 },
  { name: 'SPORT', tireFriction: 1.35, corneringStiffnessFront: 100000, corneringStiffnessRear: 118000, handbrakeForceMax: 12000 },
  { name: 'SIM', tireFriction: 1.05, corneringStiffnessFront: 80000, corneringStiffnessRear: 92000, handbrakeForceMax: 8500 },
];

export const PAINT_COLORS = [
  { name: 'CRIMSON', hex: 0xff3355 },
  { name: 'CYAN', hex: 0x5ff7ff },
  { name: 'MAGENTA', hex: 0xff3ec4 },
  { name: 'VOID BLACK', hex: 0x16171c },
  { name: 'GOLD', hex: 0xf5c542 },
  { name: 'ARCTIC', hex: 0xe8f3f5 },
];

// Matches CameraRig's own comfort scale (0 = fully static/most
// comfortable, 1 = full FOV-kick + G-force pulse effects).
export const COMFORT_LEVELS = [
  { name: 'MAX COMFORT', value: 0 },
  { name: 'REDUCED', value: 0.33 },
  { name: 'STANDARD', value: 0.66 },
  { name: 'FULL', value: 1.0 },
];

export const VIEW_OPTIONS = ['COCKPIT', 'CHASE'];

const ROWS = ['GRIP', 'PAINT', 'COMFORT', 'VIEW'];

function wrap(i, n) {
  return ((i % n) + n) % n;
}

export class CarSettings {
  constructor() {
    this.selectedRow = 0;
    this.gripIndex = 1;    // SPORT — matches VehiclePhysics's current defaults
    this.paintIndex = 0;   // CRIMSON — matches main.js's current default paint
    this.comfortIndex = 3; // FULL — matches CameraRig's current default
    this.viewIndex = 0;    // COCKPIT
  }

  get rowCount() { return ROWS.length; }
  get rowNames() { return ROWS; }
  get selectedRowName() { return ROWS[this.selectedRow]; }

  moveSelection(delta) {
    this.selectedRow = wrap(this.selectedRow + delta, ROWS.length);
  }

  /** Adjusts whichever row is currently selected by `delta` steps (wraps around). */
  adjustSelected(delta) {
    switch (ROWS[this.selectedRow]) {
      case 'GRIP': this.gripIndex = wrap(this.gripIndex + delta, GRIP_PRESETS.length); break;
      case 'PAINT': this.paintIndex = wrap(this.paintIndex + delta, PAINT_COLORS.length); break;
      case 'COMFORT': this.comfortIndex = wrap(this.comfortIndex + delta, COMFORT_LEVELS.length); break;
      case 'VIEW': this.viewIndex = wrap(this.viewIndex + delta, VIEW_OPTIONS.length); break;
    }
  }

  get grip() { return GRIP_PRESETS[this.gripIndex]; }
  get paint() { return PAINT_COLORS[this.paintIndex]; }
  get comfort() { return COMFORT_LEVELS[this.comfortIndex]; }
  get view() { return VIEW_OPTIONS[this.viewIndex]; }
}
