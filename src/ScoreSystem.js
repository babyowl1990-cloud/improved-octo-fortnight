/**
 * ScoreSystem.js
 * ------------------------------------------------------------------
 * Tracks distance, the near-miss multiplier/score, and the collision
 * -> game-over transition. Deliberately has zero rendering dependency
 * (same philosophy as VehiclePhysics.js and RingRecycler.js) — it's
 * fed events by whatever detects near-misses/collisions (currently
 * AITrafficController) and read by whatever draws the HUD (currently
 * HUDPanel), but doesn't know either of those exist.
 *
 * RULES:
 *  - Every near-miss scores `pointsPerNearMiss * currentMultiplier`,
 *    then bumps the multiplier by 1 (capped at `maxMultiplier`).
 *  - If `multiplierDecayTime` seconds pass with no near-miss, the
 *    multiplier resets to 1 — this is what makes it a "keep threading
 *    the needle" combo system rather than a one-time bonus.
 *  - A collision freezes everything (`gameOver = true`) and snapshots
 *    a `finalSummary` for the game-over screen. Further events are
 *    ignored until `reset()`.
 * ------------------------------------------------------------------
 */
export class ScoreSystem {
  constructor(options = {}) {
    this.multiplierDecayTime = options.multiplierDecayTime ?? 4.0; // seconds
    this.maxMultiplier = options.maxMultiplier ?? 10;
    this.pointsPerNearMiss = options.pointsPerNearMiss ?? 100;

    this._resetState();
  }

  _resetState() {
    this.distance = 0;
    this.multiplier = 1;
    this.score = 0;
    this.nearMissCount = 0;
    this.gameOver = false;
    this.finalSummary = null;
    this._timeSinceLastNearMiss = 0;
  }

  /** Call once per frame regardless of whether anything happened. */
  tick(dt, distanceMeters) {
    if (this.gameOver) return;
    this.distance = distanceMeters;
    this._timeSinceLastNearMiss += dt;
    if (this.multiplier > 1 && this._timeSinceLastNearMiss > this.multiplierDecayTime) {
      this.multiplier = 1;
    }
  }

  registerNearMiss() {
    if (this.gameOver) return;
    this.nearMissCount += 1;
    this.score += this.pointsPerNearMiss * this.multiplier;
    this.multiplier = Math.min(this.maxMultiplier, this.multiplier + 1);
    this._timeSinceLastNearMiss = 0;
  }

  registerCollision() {
    if (this.gameOver) return;
    this.gameOver = true;
    this.finalSummary = {
      score: this.score,
      distance: this.distance,
      nearMissCount: this.nearMissCount,
    };
  }

  reset() {
    this._resetState();
  }
}
