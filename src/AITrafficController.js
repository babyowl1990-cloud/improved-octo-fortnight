import * as THREE from 'three';
import { withVertexColor } from './HighwaySystem.js';

/**
 * AITrafficController.js
 * ------------------------------------------------------------------
 * A fixed pool of civilian cars that spawn ahead of the player and
 * respawn once they've fallen behind — the same "never create or
 * destroy, just recycle" principle as HighwaySystem/RingRecycler.
 *
 * WHY THIS DOESN'T USE RingRecycler DIRECTLY: RingRecycler assumes
 * pooled objects are STATIC at `index * spacing` — that's true for
 * road segments and streetlights, which never move once placed. A
 * traffic car isn't static: it drives forward at its own speed and
 * drifts away from wherever it started. Recycling it correctly means
 * checking the car's ACTUAL current distance behind the player, not
 * comparing a fixed home-slot position. So this file uses the same
 * conceptual trick (fixed pool, recycle whatever fell behind) but
 * with a simple per-car distance check instead of RingRecycler's
 * index math, since that math doesn't apply to moving objects.
 *
 * Each car is a small state machine:
 *   cruise -> (timer elapses, picks an adjacent lane) -> signaling
 *   signaling -> (signal lead time elapses) -> changing
 *   changing -> (glides laterally over laneChangeDuration) -> cruise
 *
 * COLLISION / NEAR-MISS MODEL: both are axis-aligned bounding-box
 * checks between the player and each traffic car (lateral half-width,
 * longitudinal half-length). A near-miss is scored the instant a car
 * passes the player longitudinally (their Z difference changes sign)
 * while laterally within a small margin of actually touching, but
 * without an overlap. Each car can only score one near-miss per pass
 * (flag resets on respawn) so lingering close to a car doesn't spam
 * points every frame.
 * ------------------------------------------------------------------
 */
export class AITrafficController {
  constructor(scene, highway, options = {}) {
    this.highway = highway;
    this.poolSize = options.poolSize ?? 18;
    this.aheadSpawnDistance = options.aheadSpawnDistance ?? 260; // m ahead of player when (re)spawned
    this.behindDespawnDistance = options.behindDespawnDistance ?? 60; // m behind player that triggers respawn

    this.minSpeed = options.minSpeed ?? 16;  // m/s (~58 km/h) — slowest civilian traffic
    this.maxSpeed = options.maxSpeed ?? 32;  // m/s (~115 km/h) — fastest civilian traffic
    // (the player's own top speed is ~65 m/s — see VehiclePhysics — so
    // there's always a healthy overtaking margin, which is the whole
    // point: traffic you can never catch isn't traffic you can weave through)

    this.laneChangeMinInterval = options.laneChangeMinInterval ?? 4;
    this.laneChangeMaxInterval = options.laneChangeMaxInterval ?? 12;
    this.laneChangeDuration = options.laneChangeDuration ?? 2.2;
    this.signalLeadTime = options.signalLeadTime ?? 1.1;

    this.halfWidth = options.halfWidth ?? 0.95;
    this.halfLength = options.halfLength ?? 2.15;
    this.playerHalfWidth = options.playerHalfWidth ?? 0.9;
    this.playerHalfLength = options.playerHalfLength ?? 2.1;
    this.nearMissLateralMargin = options.nearMissLateralMargin ?? 0.6; // extra clearance that still counts as "close"
    // Floor on how close the FIRST car in each spawn batch can land to
    // the player. Without this, car index 0's stagger math bottoms out
    // near 0m — i.e. it could spawn (or respawn after a restart)
    // almost exactly on top of the player and trigger an instant,
    // unfair collision before they've even touched the controls.
    this.minInitialSpawnDistance = options.minInitialSpawnDistance ?? 30;

    this._buildSharedAssets();
    this.cars = [];
    for (let i = 0; i < this.poolSize; i++) {
      const car = this._createCarInstance(scene);
      const startZ = this.minInitialSpawnDistance + (i / this.poolSize) * this.aheadSpawnDistance + Math.random() * 15;
      this._respawnCar(car, startZ);
      this.cars.push(car);
    }
  }

  _buildSharedAssets() {
    // One shared material for every car's body+wheels — each car's
    // individual color comes from baked-in vertex colors on its own
    // merged geometry, not from a per-car material, so the whole pool
    // still shares a single material object.
    this.carMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
    this.palette = [0x8a97a8, 0xd8d3c4, 0x46586b, 0x8a3b2c, 0x2b3a4d, 0x9a8f7e, 0x3d4550];
  }

  _buildCarGeometry(colorHex) {
    const parts = [];
    const body = new THREE.BoxGeometry(1.8, 0.55, 4.2);
    body.translate(0, 0.55, 0);
    parts.push(withVertexColor(body, colorHex));

    const wheelOffsets = [[0.85, 0.32, 1.3], [-0.85, 0.32, 1.3], [0.85, 0.32, -1.3], [-0.85, 0.32, -1.3]];
    for (const [x, y, z] of wheelOffsets) {
      const wheel = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 12);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(x, y, z);
      parts.push(withVertexColor(wheel, 0x101010));
    }
    // Cars are few enough (poolSize ~18) that unmerged per-part meshes
    // are still cheap, so — unlike HighwaySystem — this skips merging
    // parts into one draw call and keeps the code simpler.
    return parts;
  }

  _createCarInstance(scene) {
    const group = new THREE.Group();
    const colorHex = this.palette[Math.floor(Math.random() * this.palette.length)];
    for (const geo of this._buildCarGeometry(colorHex)) {
      group.add(new THREE.Mesh(geo, this.carMat));
    }

    const baseSignalMat = new THREE.MeshStandardMaterial({ color: 0x2a1a10, emissive: 0xff9900, emissiveIntensity: 0 });
    const signalMatL = baseSignalMat.clone();
    const signalMatR = baseSignalMat.clone();
    const sigGeo = new THREE.BoxGeometry(0.1, 0.1, 0.15);
    const sigL = new THREE.Mesh(sigGeo, signalMatL);
    sigL.position.set(-0.95, 0.55, 2.05);
    const sigR = new THREE.Mesh(sigGeo, signalMatR);
    sigR.position.set(0.95, 0.55, 2.05);
    group.add(sigL, sigR);

    scene.add(group);
    return {
      group, signalMatL, signalMatR,
      lane: 0, targetLane: 0, x: 0, z: 0, speed: 0,
      fromX: 0, toX: 0,
      state: 'cruise', timer: 0, laneChangeElapsed: 0,
      prevRelZ: 0, nearMissScored: false,
    };
  }

  _respawnCar(car, z) {
    const laneCount = this.highway.laneCount;
    car.lane = Math.floor(Math.random() * laneCount);
    car.targetLane = car.lane;
    car.x = this.highway.laneCenterX(car.lane);
    car.fromX = car.x;
    car.toX = car.x;
    car.z = z;
    car.speed = this.minSpeed + Math.random() * (this.maxSpeed - this.minSpeed);
    car.state = 'cruise';
    car.timer = this._randomLaneChangeInterval();
    car.laneChangeElapsed = 0;
    car.nearMissScored = false;
    car.prevRelZ = 0;
    car.signalMatL.emissiveIntensity = 0;
    car.signalMatR.emissiveIntensity = 0;
  }

  _randomLaneChangeInterval() {
    return this.laneChangeMinInterval + Math.random() * (this.laneChangeMaxInterval - this.laneChangeMinInterval);
  }

  /**
   * @param {number} playerX
   * @param {number} playerZ
   * @param {number} dt
   * @returns {{ collidedWith: object|null, nearMisses: object[] }}
   */
  update(playerX, playerZ, dt) {
    const nearMisses = [];
    let collidedWith = null;
    const laneCount = this.highway.laneCount;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    for (const car of this.cars) {
      car.z += car.speed * dt;
      this._updateLaneChangeState(car, laneCount, dt);
      this._updateSignalVisual(car, nowMs);
      car.group.position.set(car.x, 0, car.z);

      if (car.z < playerZ - this.behindDespawnDistance) {
        this._respawnCar(car, playerZ + this.aheadSpawnDistance + (Math.random() - 0.5) * 40);
        continue; // a just-respawned car isn't checked for collision/near-miss this frame
      }

      const relX = car.x - playerX;
      const relZ = car.z - playerZ;
      const combinedHalfWidth = this.halfWidth + this.playerHalfWidth;
      const combinedHalfLength = this.halfLength + this.playerHalfLength;
      const overlappingX = Math.abs(relX) < combinedHalfWidth;
      const overlappingZ = Math.abs(relZ) < combinedHalfLength;

      if (overlappingX && overlappingZ) {
        if (!collidedWith) collidedWith = car;
      } else {
        const lateralGap = Math.abs(relX) - combinedHalfWidth;
        const justPassed = car.prevRelZ !== 0 && Math.sign(relZ) !== Math.sign(car.prevRelZ);
        if (!car.nearMissScored && justPassed && lateralGap < this.nearMissLateralMargin) {
          nearMisses.push(car);
          car.nearMissScored = true;
        }
      }
      car.prevRelZ = relZ;
    }

    return { collidedWith, nearMisses };
  }

  _updateLaneChangeState(car, laneCount, dt) {
    car.timer -= dt;
    if (car.state === 'cruise' && car.timer <= 0) {
      const options = [];
      if (car.lane > 0) options.push(car.lane - 1);
      if (car.lane < laneCount - 1) options.push(car.lane + 1);
      if (options.length > 0) {
        car.targetLane = options[Math.floor(Math.random() * options.length)];
        car.state = 'signaling';
        car.timer = this.signalLeadTime;
      } else {
        car.timer = this._randomLaneChangeInterval(); // boxed in (single lane) — wait and re-roll later
      }
    } else if (car.state === 'signaling' && car.timer <= 0) {
      car.state = 'changing';
      car.laneChangeElapsed = 0;
      car.fromX = car.x;
      car.toX = this.highway.laneCenterX(car.targetLane);
    } else if (car.state === 'changing') {
      car.laneChangeElapsed += dt;
      const t = Math.min(1, car.laneChangeElapsed / this.laneChangeDuration);
      const smooth = t * t * (3 - 2 * t); // smoothstep — glides rather than snapping
      car.x = car.fromX + (car.toX - car.fromX) * smooth;
      if (t >= 1) {
        car.lane = car.targetLane;
        car.x = car.toX;
        car.state = 'cruise';
        car.timer = this._randomLaneChangeInterval();
      }
    }
  }

  _updateSignalVisual(car, nowMs) {
    const blinking = car.state === 'signaling' || car.state === 'changing';
    const blinkOn = blinking && Math.floor(nowMs / 250) % 2 === 0;
    const turningLeft = car.targetLane < car.lane;
    car.signalMatL.emissiveIntensity = blinkOn && turningLeft ? 3 : 0;
    car.signalMatR.emissiveIntensity = blinkOn && !turningLeft ? 3 : 0;
  }

  /** Redistributes every car ahead of a fresh player position — used when restarting after a collision. */
  resetAll(playerZ) {
    this.cars.forEach((car, i) => {
      const z = playerZ + this.minInitialSpawnDistance + (i / this.poolSize) * this.aheadSpawnDistance + Math.random() * 15;
      this._respawnCar(car, z);
    });
  }
}
