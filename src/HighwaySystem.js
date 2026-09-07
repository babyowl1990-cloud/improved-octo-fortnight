import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RingRecycler } from './RingRecycler.js';

/**
 * HighwaySystem.js
 * ------------------------------------------------------------------
 * An endless straight multi-lane highway built from a small fixed
 * pool of objects that get recycled (moved from behind the car to
 * ahead of it) rather than created/destroyed as you drive — see
 * RingRecycler.js for the recycling mechanics themselves.
 *
 * PERFORMANCE APPROACH (this matters a lot in VR — you're rendering
 * every draw call twice, once per eye):
 *   - Road surface + lane markings + guardrails for ALL segments are
 *     each a SINGLE THREE.InstancedMesh. Whether the highway pool
 *     holds 12 segments or 200, that's still just 2 draw calls.
 *   - Streetlight poles/lamps: same trick, 4 InstancedMeshes total
 *     (pole-left, pole-right, lamp-left, lamp-right).
 *   - Skyline buildings: 2 InstancedMeshes (left/right), one shared
 *     "lit windows" texture, varied per-instance via random scale.
 *   - Only a SMALL FIXED POOL of real THREE.PointLight objects exists
 *     (default 4) — real-time lights are one of the most expensive
 *     things you can add to a WebGL scene. Instead of ever creating
 *     more, we just re-park those same 4 lights at whichever
 *     streetlight stations are currently nearest the car. Every other
 *     "lit" streetlight is just an emissive-material mesh — it looks
 *     lit but costs nothing extra to render.
 *
 * SCOPE NOTE: this is a straight highway (no curvature) for this
 * drop. The lane-center/road-width API below is what a future gentle
 * curve system would bend around a spline instead of a straight Z
 * axis — nothing downstream (traffic, gameplay) needs to change for
 * that, since everything already asks HighwaySystem for lane
 * positions rather than assuming raw world X.
 * ------------------------------------------------------------------
 */

function withVertexColor(geometry, colorHex) {
  const c = new THREE.Color(colorHex);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export class HighwaySystem {
  constructor(scene, options = {}) {
    this.laneCount = options.laneCount ?? 3;
    this.laneWidth = options.laneWidth ?? 3.6; // meters — real US highway lane width
    this.roadWidth = this.laneCount * this.laneWidth;
    this.segmentLength = options.segmentLength ?? 50;

    this._buildMaterials();
    this._buildRoadPool(scene, options.segmentSlots ?? 14, options.segmentsAhead ?? 9);
    this._buildStreetlights(scene, options);
    this._buildSkyline(scene, options);

    this._dummy = new THREE.Object3D(); // scratch object reused every frame, avoids per-frame allocation
  }

  /** World-space X for the center of a given lane index (0 = leftmost). */
  laneCenterX(laneIndex) {
    return (laneIndex - (this.laneCount - 1) / 2) * this.laneWidth;
  }

  /** Call once per frame with the car's world-space Z (forward distance traveled). */
  update(carZ) {
    this._updateRoad(carZ);
    this._updateStreetlights(carZ);
    this._updateSkyline(carZ);
  }

  // ------------------------------------------------------------------
  _buildMaterials() {
    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    this.railMat = new THREE.MeshStandardMaterial({ color: 0x2a2e38, metalness: 0.6, roughness: 0.4 });
    this.poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1e24, metalness: 0.5, roughness: 0.6 });
    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a, emissive: 0xfff2c2, emissiveIntensity: 2.2, roughness: 0.4,
    });
  }

  // ---- Road (instanced) ----
  _buildRoadPool(scene, slotCount, aheadCount) {
    this.segmentsAhead = aheadCount;
    const roadGeo = this._buildSegmentGeometry();
    const railGeo = this._buildGuardrailGeometry();

    this.roadRecycler = new RingRecycler(slotCount, this.segmentLength, 0);
    this.roadMesh = new THREE.InstancedMesh(roadGeo, this.roadMat, slotCount);
    this.railMesh = new THREE.InstancedMesh(railGeo, this.railMat, slotCount);
    scene.add(this.roadMesh, this.railMesh);

    const dummy = new THREE.Object3D();
    for (let i = 0; i < slotCount; i++) {
      dummy.position.set(0, 0, this.roadRecycler.indexToZ(i));
      dummy.updateMatrix();
      this.roadMesh.setMatrixAt(i, dummy.matrix);
      this.railMesh.setMatrixAt(i, dummy.matrix);
    }
    this.roadMesh.instanceMatrix.needsUpdate = true;
    this.railMesh.instanceMatrix.needsUpdate = true;
  }

  _buildSegmentGeometry() {
    const half = this.segmentLength / 2;
    const parts = [];

    const asphalt = new THREE.PlaneGeometry(this.roadWidth, this.segmentLength);
    asphalt.rotateX(-Math.PI / 2);
    parts.push(withVertexColor(asphalt, 0x15171d));

    const shoulderWidth = 2.6;
    for (const side of [-1, 1]) {
      const shoulder = new THREE.PlaneGeometry(shoulderWidth, this.segmentLength);
      shoulder.rotateX(-Math.PI / 2);
      shoulder.translate(side * (this.roadWidth / 2 + shoulderWidth / 2), -0.01, 0);
      parts.push(withVertexColor(shoulder, 0x0c0d10));
    }

    for (const side of [-1, 1]) {
      const edge = new THREE.BoxGeometry(0.18, 0.02, this.segmentLength);
      edge.translate(side * (this.roadWidth / 2 - 0.15), 0.011, 0);
      parts.push(withVertexColor(edge, 0xe8e8e8));
    }

    // Dashed lane-divider lines at each internal lane boundary
    const dashLen = 3, dashGap = 4.5, step = dashLen + dashGap;
    for (let b = 1; b < this.laneCount; b++) {
      const bx = this.laneCenterX(b - 1) + this.laneWidth / 2;
      for (let z = -half; z < half; z += step) {
        const dash = new THREE.BoxGeometry(0.15, 0.02, dashLen);
        dash.translate(bx, 0.011, z + dashLen / 2);
        parts.push(withVertexColor(dash, 0xdedede));
      }
    }

    return mergeGeometries(parts, false);
  }

  _buildGuardrailGeometry() {
    const parts = [];
    const beamHeight = 0.6;
    for (const side of [-1, 1]) {
      const x = side * (this.roadWidth / 2 + 3.0);
      const beam = new THREE.BoxGeometry(0.08, 0.15, this.segmentLength);
      beam.translate(x, beamHeight, 0);
      parts.push(beam);
      for (let z = -this.segmentLength / 2; z < this.segmentLength / 2; z += 5) {
        const post = new THREE.BoxGeometry(0.1, beamHeight, 0.1);
        post.translate(x, beamHeight / 2, z);
        parts.push(post);
      }
    }
    return mergeGeometries(parts, false);
  }

  _updateRoad(carZ) {
    const changes = this.roadRecycler.advanceTo(carZ, this.segmentsAhead);
    if (changes.length === 0) return;
    for (const c of changes) {
      this._dummy.position.set(0, 0, c.z);
      this._dummy.updateMatrix();
      this.roadMesh.setMatrixAt(c.slot, this._dummy.matrix);
      this.railMesh.setMatrixAt(c.slot, this._dummy.matrix);
    }
    this.roadMesh.instanceMatrix.needsUpdate = true;
    this.railMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- Streetlights (instanced fixtures + a small real-light pool) ----
  _buildStreetlights(scene, options) {
    this.lightSpacing = options.lightSpacing ?? 45;
    const slotCount = options.lightSlots ?? 10;
    this.lightsAhead = options.lightsAhead ?? 6;
    const poleHeight = 6.5;

    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, poleHeight, 8);
    poleGeo.translate(0, poleHeight / 2, 0);
    const armGeo = new THREE.BoxGeometry(1.1, 0.08, 0.08);
    armGeo.translate(0.55, poleHeight - 0.1, 0);
    const poleWithArm = mergeGeometries([poleGeo, armGeo], false);
    const lampGeo = new THREE.SphereGeometry(0.22, 8, 6);
    lampGeo.translate(1.1, poleHeight - 0.15, 0);

    this.poleRecycler = new RingRecycler(slotCount, this.lightSpacing, 0);
    this.poleMesh = { left: new THREE.InstancedMesh(poleWithArm, this.poleMat, slotCount),
                       right: new THREE.InstancedMesh(poleWithArm, this.poleMat, slotCount) };
    this.lampMesh = { left: new THREE.InstancedMesh(lampGeo, this.lampMat, slotCount),
                       right: new THREE.InstancedMesh(lampGeo, this.lampMat, slotCount) };
    scene.add(this.poleMesh.left, this.poleMesh.right, this.lampMesh.left, this.lampMesh.right);

    const dummy = new THREE.Object3D();
    for (const side of ['left', 'right']) {
      const signX = side === 'left' ? -1 : 1;
      for (let i = 0; i < slotCount; i++) {
        this._placeStreetlight(dummy, side, i, this.poleRecycler.indexToZ(i), signX);
      }
      this.poleMesh[side].instanceMatrix.needsUpdate = true;
      this.lampMesh[side].instanceMatrix.needsUpdate = true;
    }

    // Small fixed pool of REAL dynamic lights — see class doc for why
    // this stays tiny regardless of how long the highway pool is.
    const realLightCount = options.realLightCount ?? 4;
    this.realLights = [];
    for (let i = 0; i < realLightCount; i++) {
      const light = new THREE.PointLight(0xfff2c2, 8, 22, 2);
      scene.add(light);
      this.realLights.push(light);
    }
  }

  _placeStreetlight(dummy, side, slot, z, signX) {
    const x = signX * (this.roadWidth / 2 + 3.6);
    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, side === 'left' ? 0 : Math.PI, 0); // arm/lamp face over the road on both sides
    dummy.updateMatrix();
    this.poleMesh[side].setMatrixAt(slot, dummy.matrix);
    this.lampMesh[side].setMatrixAt(slot, dummy.matrix);
  }

  _updateStreetlights(carZ) {
    const changes = this.poleRecycler.advanceTo(carZ, this.lightsAhead);
    const dummy = this._dummy;
    if (changes.length > 0) {
      for (const c of changes) {
        this._placeStreetlight(dummy, 'left', c.slot, c.z, -1);
        this._placeStreetlight(dummy, 'right', c.slot, c.z, 1);
      }
      for (const side of ['left', 'right']) {
        this.poleMesh[side].instanceMatrix.needsUpdate = true;
        this.lampMesh[side].instanceMatrix.needsUpdate = true;
      }
    }

    // Re-park the small real-light pool at the nearest stations AHEAD
    // of the car — cheap arithmetic, no scene traversal/search needed
    // since stations sit at exact multiples of lightSpacing.
    const baseIndex = Math.floor(carZ / this.lightSpacing);
    for (let i = 0; i < this.realLights.length; i++) {
      const stationIndex = baseIndex + i;
      const side = stationIndex % 2 === 0 ? -1 : 1;
      this.realLights[i].position.set(
        side * (this.roadWidth / 2 + 3.6 + 1.1), 6.3, stationIndex * this.lightSpacing
      );
    }
  }

  // ---- Skyline (instanced, cheap "lit windows" backdrop) ----
  _buildSkyline(scene, options) {
    const slotCount = options.buildingSlots ?? 16;
    const spacing = options.buildingSpacing ?? 65;
    this.buildingAhead = options.buildingAhead ?? 10;
    this.buildingDistance = options.buildingDistance ?? this.roadWidth / 2 + 34;

    const tex = this._buildWindowTexture();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0c12, emissive: 0xffdf94, emissiveMap: tex, map: tex, emissiveIntensity: 0.55, roughness: 1,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1); // unit cube; per-instance scale gives each building its size

    this.skylineRecycler = { left: new RingRecycler(slotCount, spacing, 0), right: new RingRecycler(slotCount, spacing, 0) };
    this.skylineMesh = { left: new THREE.InstancedMesh(geo, mat, slotCount), right: new THREE.InstancedMesh(geo, mat, slotCount) };
    scene.add(this.skylineMesh.left, this.skylineMesh.right);

    const dummy = new THREE.Object3D();
    for (const side of ['left', 'right']) {
      for (let i = 0; i < slotCount; i++) {
        this._placeBuilding(dummy, side, i, this.skylineRecycler[side].indexToZ(i));
      }
      this.skylineMesh[side].instanceMatrix.needsUpdate = true;
    }
  }

  _buildWindowTexture() {
    const w = 32, h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffe6a8';
    for (let y = 2; y < h; y += 4) {
      for (let x = 2; x < w; x += 4) {
        if (Math.random() < 0.32) ctx.fillRect(x, y, 2, 2);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  _placeBuilding(dummy, side, slot, z) {
    const signX = side === 'left' ? -1 : 1;
    const width = 8 + Math.random() * 16;
    const depth = 8 + Math.random() * 16;
    const height = 18 + Math.random() * 75;
    dummy.position.set(signX * (this.buildingDistance + Math.random() * 20), height / 2, z);
    dummy.scale.set(width, height, depth);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    this.skylineMesh[side].setMatrixAt(slot, dummy.matrix);
  }

  _updateSkyline(carZ) {
    for (const side of ['left', 'right']) {
      const changes = this.skylineRecycler[side].advanceTo(carZ, this.buildingAhead);
      if (changes.length === 0) continue;
      for (const c of changes) this._placeBuilding(this._dummy, side, c.slot, c.z);
      this.skylineMesh[side].instanceMatrix.needsUpdate = true;
    }
  }
}
