// node test/input-controller.test.mjs
// Minimal window/keyboard-event stub — VRInputController only needs
// addEventListener/removeEventListener for keydown/keyup.
const listeners = { keydown: [], keyup: [] };
globalThis.window = {
  addEventListener(type, fn) { listeners[type]?.push(fn); },
  removeEventListener(type, fn) {
    const arr = listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
};
function pressKey(code) { for (const fn of listeners.keydown) fn({ code }); }
function releaseKey(code) { for (const fn of listeners.keyup) fn({ code }); }

const { VRInputController } = await import('../src/VRInputController.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

// A renderer stand-in with no active XR session — matches desktop testing.
function fakeRenderer() {
  return { xr: { getSession: () => null, getCamera: () => null } };
}

// --- Test 1: correct usage — ONE update() call per rendered frame ---
// This is what main.js does after the fix: sample input once, then run
// however many physics sub-steps that frame needs against the same sample.
{
  const input = new VRInputController(fakeRenderer());
  pressKey('KeyC');
  const firstFrameToggled = input.update().viewToggled;
  assert(firstFrameToggled === true, 'viewToggled is true on the frame C is first pressed');

  // Simulate the key still being held across several subsequent rendered
  // frames — should NOT toggle again until released and pressed again.
  const secondFrameToggled = input.update().viewToggled;
  const thirdFrameToggled = input.update().viewToggled;
  assert(secondFrameToggled === false && thirdFrameToggled === false,
    'viewToggled stays false on later frames while C is held (no repeat-fire)');

  releaseKey('KeyC');
  input.update();
  pressKey('KeyC');
  const nextPressToggled = input.update().viewToggled;
  assert(nextPressToggled === true, 'viewToggled fires again on a fresh press after release');
}

// --- Test 2: regression test for the actual bug — calling update()
// MULTIPLE TIMES within what should be a single frame (the old main.js
// pattern, once per physics sub-step) must not be how this is used, and
// this test documents exactly why: the rising edge gets consumed by the
// second call before any caller can observe it from the first.
{
  const input = new VRInputController(fakeRenderer());
  pressKey('KeyC');
  // Read .viewToggled immediately after each call — input.update() returns
  // the SAME mutable state object every time, so storing the object
  // itself (rather than the primitive value) would just alias the final
  // mutation, not a snapshot of that call.
  const subStep1Toggled = input.update().viewToggled; // would have been true
  const subStep2Toggled = input.update().viewToggled; // immediately eats the edge
  const subStep3Toggled = input.update().viewToggled;
  assert(subStep1Toggled === true, 'sanity check: the raw edge IS true on the very first call');
  assert(subStep2Toggled === false && subStep3Toggled === false,
    'calling update() again within the "same frame" consumes the edge — this is why input.update() must be called exactly once per rendered frame, not once per physics sub-step (see main.js)');
}

// --- Test 3: menu toggle (M key) follows the same rising-edge pattern as the view toggle ---
{
  const input = new VRInputController(fakeRenderer());
  pressKey('KeyM');
  const firstToggled = input.update().menuToggled;
  assert(firstToggled === true, 'menuToggled is true on the frame M is first pressed');
  const heldToggled = input.update().menuToggled;
  assert(heldToggled === false, 'menuToggled stays false while M is held (no repeat-fire)');
  releaseKey('KeyM');
  input.update();
  pressKey('KeyM');
  assert(input.update().menuToggled === true, 'menuToggled fires again on a fresh press after release');
}

// --- Test 4: view toggle and menu toggle are independent — pressing one never fires the other ---
{
  const input = new VRInputController(fakeRenderer());
  pressKey('KeyC');
  const afterC = input.update();
  assert(afterC.viewToggled === true && afterC.menuToggled === false, 'pressing C only toggles the view, not the menu');
  releaseKey('KeyC');
  input.update();
  pressKey('KeyM');
  const afterM = input.update();
  assert(afterM.menuToggled === true && afterM.viewToggled === false, 'pressing M only toggles the menu, not the view');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
