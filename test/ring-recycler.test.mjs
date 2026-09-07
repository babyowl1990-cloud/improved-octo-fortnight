// node test/ring-recycler.test.mjs
import { RingRecycler } from '../src/RingRecycler.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

function slotsAreUnique(recycler) {
  const seen = new Set(recycler._slotOfIndex.values());
  return seen.size === recycler.slotCount;
}

// --- Test 1: no motion yet, ahead window already satisfied -> no changes ---
{
  const r = new RingRecycler(10, 50, 0);
  const changes = r.advanceTo(0, 8); // maxIndex already 9, desired 0+8=8 -> nothing to do
  assert(changes.length === 0, 'no reassignment needed when ahead-window is already covered');
}

// --- Test 2: steady forward motion recycles exactly the expected count ---
{
  const r = new RingRecycler(10, 50, 0);
  let totalChanges = 0;
  for (let z = 0; z <= 2000; z += 50) {
    totalChanges += r.advanceTo(z, 8).length;
  }
  assert(slotsAreUnique(r), 'every slot holds a unique logical index after steady motion');
  assert(totalChanges > 0, 'recycling actually happened over 2000m of travel');
  assert(r.maxIndex - r.minIndex + 1 === 10, 'window stays exactly slotCount wide');
}

// --- Test 3: a big single-frame jump (e.g. respawn/teleport) still recycles correctly ---
{
  const r = new RingRecycler(10, 50, 0);
  const changes = r.advanceTo(10000, 8); // huge jump in one call
  assert(slotsAreUnique(r), 'unique slots survive a large single-frame jump');
  assert(changes.length > 5, `large jump produces multiple reassignments (${changes.length})`);
  assert(r.maxIndex - r.minIndex + 1 === 10, 'window still exactly slotCount wide after a jump');
}

// --- Test 4: indexToZ/slotFor stay consistent with the assignment map ---
{
  const r = new RingRecycler(6, 40, 0);
  r.advanceTo(500, 4);
  for (let idx = r.minIndex; idx <= r.maxIndex; idx++) {
    assert(r.slotFor(idx) !== undefined, `every index in [min,max] has an assigned slot (idx ${idx})`);
  }
  assert(r.indexToZ(3) === 120, 'indexToZ computes index * spacing correctly');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
