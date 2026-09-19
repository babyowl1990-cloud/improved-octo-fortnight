// node test/car-settings.test.mjs
import { CarSettings, GRIP_PRESETS, PAINT_COLORS, COMFORT_LEVELS, VIEW_OPTIONS } from '../src/CarSettings.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

// --- row navigation wraps in both directions ---
{
  const s = new CarSettings();
  assert(s.selectedRowName === 'GRIP', 'starts on the GRIP row');
  s.moveSelection(1);
  assert(s.selectedRowName === 'PAINT', 'moving down selects the next row');
  s.moveSelection(-1);
  assert(s.selectedRowName === 'GRIP', 'moving back up returns to GRIP');
  s.moveSelection(-1);
  assert(s.selectedRowName === 'VIEW', 'moving up from the first row wraps to the last row');
  s.moveSelection(1);
  assert(s.selectedRowName === 'GRIP', 'moving down from the last row wraps back to the first');
}

// --- adjusting a row only changes that row, and wraps within its own option list ---
{
  const s = new CarSettings();
  const startPaint = s.paintIndex;
  s.adjustSelected(1); // selected row is GRIP
  assert(s.gripIndex !== 1 || GRIP_PRESETS.length === 1, 'adjusting while on GRIP changes the grip index');
  assert(s.paintIndex === startPaint, 'adjusting GRIP does not touch PAINT');

  s.moveSelection(1); // -> PAINT
  for (let i = 0; i < PAINT_COLORS.length; i++) s.adjustSelected(1);
  assert(s.paintIndex === 0 + (PAINT_COLORS.length % PAINT_COLORS.length), 'cycling through every paint option returns to the start (wraps)');

  s.adjustSelected(-1);
  assert(s.paintIndex === PAINT_COLORS.length - 1, 'adjusting backward from index 0 wraps to the last option');
}

// --- getters return the actual preset objects, matching the current index ---
{
  const s = new CarSettings();
  assert(s.grip.name === GRIP_PRESETS[s.gripIndex].name, 'grip getter matches gripIndex');
  s.moveSelection(1); s.adjustSelected(2);
  assert(s.paint.hex === PAINT_COLORS[s.paintIndex].hex, 'paint getter tracks paintIndex after adjustment');
  s.moveSelection(1); s.adjustSelected(1);
  assert(s.comfort.value === COMFORT_LEVELS[s.comfortIndex].value, 'comfort getter tracks comfortIndex after adjustment');
  s.moveSelection(1); s.adjustSelected(1);
  assert(VIEW_OPTIONS.includes(s.view), 'view getter returns one of the valid view options');
}

// --- defaults match what the rest of the codebase currently uses, so opening
// the menu for the first time doesn't silently change anything ---
{
  const s = new CarSettings();
  assert(s.grip.name === 'SPORT', 'default grip preset is SPORT, matching VehiclePhysics\'s current defaults');
  assert(s.comfort.value === 1.0, 'default comfort is 1.0 (FULL), matching CameraRig\'s current default');
  assert(s.view === 'COCKPIT', 'default view is COCKPIT');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
