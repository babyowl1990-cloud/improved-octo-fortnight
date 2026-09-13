// node test/score-system.test.mjs
import { ScoreSystem } from '../src/ScoreSystem.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

// --- Test 1: near-misses accumulate score and grow the multiplier ---
{
  const s = new ScoreSystem({ pointsPerNearMiss: 100 });
  s.registerNearMiss();
  assert(s.score === 100 && s.multiplier === 2, `first near-miss: score=100,mult=2 (got score=${s.score},mult=${s.multiplier})`);
  s.registerNearMiss();
  assert(s.score === 300 && s.multiplier === 3, `second near-miss compounds (got score=${s.score},mult=${s.multiplier})`);
}

// --- Test 2: multiplier caps at maxMultiplier ---
{
  const s = new ScoreSystem({ maxMultiplier: 3 });
  for (let i = 0; i < 10; i++) s.registerNearMiss();
  assert(s.multiplier === 3, `multiplier caps at configured max (got ${s.multiplier})`);
}

// --- Test 3: multiplier decays to 1 after enough quiet time ---
{
  const s = new ScoreSystem({ multiplierDecayTime: 2.0 });
  s.registerNearMiss();
  assert(s.multiplier === 2, 'multiplier raised after a near-miss');
  s.tick(1.0, 50);
  assert(s.multiplier === 2, 'multiplier NOT yet decayed before the timeout');
  s.tick(1.5, 51); // total 2.5s since last near-miss > 2.0s decay time
  assert(s.multiplier === 1, `multiplier decays back to 1 after quiet period (got ${s.multiplier})`);
}

// --- Test 4: a near-miss resets the decay clock ---
{
  const s = new ScoreSystem({ multiplierDecayTime: 2.0 });
  s.registerNearMiss();
  s.tick(1.9, 10);
  s.registerNearMiss(); // should reset the quiet timer
  s.tick(1.9, 11);
  assert(s.multiplier === 3, `repeated near-misses within the window keep compounding (got ${s.multiplier})`);
}

// --- Test 5: collision freezes state and produces a summary ---
{
  const s = new ScoreSystem();
  s.registerNearMiss();
  s.tick(0.1, 123.4);
  s.registerCollision();
  assert(s.gameOver === true, 'collision sets gameOver');
  assert(s.finalSummary && s.finalSummary.distance === 123.4, 'finalSummary captures distance at time of collision');
  const scoreBefore = s.score;
  s.registerNearMiss(); // should be ignored post-collision
  s.tick(5, 999);
  assert(s.score === scoreBefore, 'events after collision are ignored');
  assert(s.distance === 123.4, 'distance frozen after collision');
}

// --- Test 6: reset() returns to a clean state ---
{
  const s = new ScoreSystem();
  s.registerNearMiss();
  s.registerCollision();
  s.reset();
  assert(s.gameOver === false && s.score === 0 && s.multiplier === 1 && s.finalSummary === null,
    'reset() clears score, multiplier, gameOver, and summary');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
