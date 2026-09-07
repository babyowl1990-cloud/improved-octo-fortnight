/**
 * RingRecycler.js
 * ------------------------------------------------------------------
 * The core trick behind every "endless road" system: you never create
 * or destroy meshes while driving. You keep a fixed pool of N slots,
 * and as the car moves forward, whichever slot is now furthest BEHIND
 * gets its logical index bumped to be the new furthest-AHEAD slot
 * (then repositioned there). From the fixed pool's point of view,
 * nothing was created or destroyed — a segment/streetlight/traffic
 * car just teleported from behind the camera to ahead of it, which is
 * invisible to the player.
 *
 * This class is deliberately pure logic (no THREE, no meshes) so it's
 * unit-testable and reusable — HighwaySystem uses it for road segments
 * AND streetlights, and the upcoming AI traffic controller will reuse
 * it too instead of writing this bookkeeping a third time.
 * ------------------------------------------------------------------
 */
export class RingRecycler {
  /**
   * @param {number} slotCount - fixed number of pooled objects
   * @param {number} spacing - world-space distance between consecutive indices
   * @param {number} startIndex - logical index of the first (furthest-behind) slot
   */
  constructor(slotCount, spacing, startIndex = 0) {
    this.slotCount = slotCount;
    this.spacing = spacing;
    this.minIndex = startIndex;
    this.maxIndex = startIndex + slotCount - 1;

    // slotOfIndex maps a logical index -> which physical pool slot (0..slotCount-1) currently holds it.
    this._slotOfIndex = new Map();
    for (let i = 0; i < slotCount; i++) this._slotOfIndex.set(startIndex + i, i);
  }

  /**
   * Call once per frame with how far forward the reference point (the
   * car) has traveled. Returns a list of reassignments to apply to
   * your actual mesh pool this frame — usually empty, occasionally one
   * entry, and possibly several if the car teleported a long distance.
   *
   * @param {number} forwardPos - world-space distance along the track
   * @param {number} aheadCount - how many indices ahead of the car must stay populated
   * @returns {{slot:number, oldIndex:number, newIndex:number, z:number}[]}
   */
  advanceTo(forwardPos, aheadCount) {
    const desiredMaxIndex = Math.floor(forwardPos / this.spacing) + aheadCount;
    const changes = [];
    // Loop (not `if`) so a big single-frame jump (teleport/respawn) still
    // recycles every slot that needs it, not just one.
    while (this.maxIndex < desiredMaxIndex) {
      const oldIndex = this.minIndex;
      const slot = this._slotOfIndex.get(oldIndex);
      const newIndex = this.maxIndex + 1;

      this._slotOfIndex.delete(oldIndex);
      this._slotOfIndex.set(newIndex, slot);

      changes.push({ slot, oldIndex, newIndex, z: newIndex * this.spacing });

      this.maxIndex = newIndex;
      this.minIndex = this.maxIndex - this.slotCount + 1;
    }
    return changes;
  }

  /** World-space position for a given logical index. */
  indexToZ(index) {
    return index * this.spacing;
  }

  /** Which physical slot currently holds a given logical index (or undefined). */
  slotFor(index) {
    return this._slotOfIndex.get(index);
  }
}
