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
 *   - Road surface + lane markings + guardrails + lane reflectors for
 *     ALL segments are each a SINGLE THREE.InstancedMesh. Whether the
 *     highway pool holds 12 segments or 200, that's still just 3 draw
 *     calls. Reflectors share the road's own recycler rather than
 *     getting a separate pool, since their positions are tied 1:1 to
 *     segment position anyway.
 *   - Streetlight poles/lamps: same trick, 4 InstancedMeshes total
 *     (pole-left, pole-right, lamp-left, lamp-right).
 *   - Skyline buildings: 2 InstancedMeshes (left/right), one shared
 *     "lit windows" texture, varied per-instance via random scale.
 *   - Overhead gantry signs and roadside billboards: sparse pools
 *     (every few hundred meters, not every segment) with their own
 *     RingRecyclers, 2 InstancedMeshes each (structure + textured panel).
 *   - A single large static ground plane (one draw call, not pooled —
 *     big enough that it doesn't need recycling within one rebase span).
 *   - Only a SMALL FIXED POOL of real THREE.PointLight objects exists
 *     (default 4) — real-time lights are one of the most expensive
 *     things you can add to a WebGL scene. Instead of ever creating
 *     more, we just re-park those same 4 lights at whichever
 *     streetlight stations are currently nearest the car. Every other
 *     "lit" streetlight is just an emissive-material mesh — it looks
 *     lit but costs nothing extra to render.
 *   - Total: ~14 draw calls for the entire endless environment,
 *     regardless of how long any individual pool's span is.
 *
 * SCOPE NOTE: this is a straight highway (no curvature) for this
 * drop. The lane-center/road-width API below is what a future gentle
 * curve system would bend around a spline instead of a straight Z
 * axis — nothing downstream (traffic, gameplay) needs to change for
 * that, since everything already asks HighwaySystem for lane
 * positions rather than assuming raw world X.
 * ------------------------------------------------------------------
 */

export function withVertexColor(geometry, colorHex) {
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
    this._buildGround(scene);
    this._buildRoadPool(scene, options.segmentSlots ?? 14, options.segmentsAhead ?? 9);
    this._buildStreetlights(scene, options);
    this._buildSkyline(scene, options);
    this._buildGantries(scene, options);
    this._buildBillboards(scene, options);

    this._dummy = new THREE.Object3D(); // scratch object reused every frame, avoids per-frame allocation
  }

  /** World-space X for the center of a given lane index (0 = leftmost). */
  laneCenterX(laneIndex) {
    return (laneIndex - (this.laneCount - 1) / 2) * this.laneWidth;
  }

  /** Call once per frame with the car's world-space Z (forward distance traveled). */
  update(carZ) {
    this.ground.position.z = carZ; // single large static plane, just needs to stay roughly centered under the player
    this._updateRoad(carZ);
    this._updateStreetlights(carZ);
    this._updateSkyline(carZ);
    this._updateGantries(carZ);
    this._updateBillboards(carZ);
  }

  /**
   * Re-anchors every pool (road, streetlights, skyline) around a new
   * player position. Needed because RingRecycler only ever recycles
   * FORWARD (it grows the window when the car has moved far enough
   * ahead) — it has no concept of the car teleporting BACKWARD, which
   * is exactly what a post-collision restart does. Without this, every
   * pool keeps showing whatever was near the crash site: the road you
   * respawn onto doesn't match where the car actually is.
   */
  reset(playerZ = 0) {
    const dummy = this._dummy;

    const roadStartIndex = Math.floor(playerZ / this.segmentLength);
    this.roadRecycler = new RingRecycler(this.roadMesh.count, this.segmentLength, roadStartIndex);
    for (let i = 0; i < this.roadMesh.count; i++) {
      dummy.position.set(0, 0, this.roadRecycler.indexToZ(roadStartIndex + i));
      dummy.updateMatrix();
      this.roadMesh.setMatrixAt(i, dummy.matrix);
      this.railMesh.setMatrixAt(i, dummy.matrix);
      this.reflectorMesh.setMatrixAt(i, dummy.matrix);
    }
    this.roadMesh.instanceMatrix.needsUpdate = true;
    this.railMesh.instanceMatrix.needsUpdate = true;
    this.reflectorMesh.instanceMatrix.needsUpdate = true;
    this.ground.position.z = playerZ;

    const poleStartIndex = Math.floor(playerZ / this.lightSpacing);
    const poleSlotCount = this.poleMesh.left.count;
    this.poleRecycler = new RingRecycler(poleSlotCount, this.lightSpacing, poleStartIndex);
    for (let i = 0; i < poleSlotCount; i++) {
      const z = this.poleRecycler.indexToZ(poleStartIndex + i);
      this._placeStreetlight(dummy, 'left', i, z, -1);
      this._placeStreetlight(dummy, 'right', i, z, 1);
    }
    for (const side of ['left', 'right']) {
      this.poleMesh[side].instanceMatrix.needsUpdate = true;
      this.lampMesh[side].instanceMatrix.needsUpdate = true;
    }

    for (const side of ['left', 'right']) {
      const slotCount = this.skylineMesh[side].count;
      const spacing = this.skylineRecycler[side].spacing;
      const startIndex = Math.floor(playerZ / spacing);
      this.skylineRecycler[side] = new RingRecycler(slotCount, spacing, startIndex);
      for (let i = 0; i < slotCount; i++) {
        this._placeBuilding(dummy, side, i, this.skylineRecycler[side].indexToZ(startIndex + i));
      }
      this.skylineMesh[side].instanceMatrix.needsUpdate = true;
    }

    const gantryStartIndex = Math.floor(playerZ / this.gantrySpacing);
    this.gantryRecycler = new RingRecycler(this.gantryStructMesh.count, this.gantrySpacing, gantryStartIndex);
    for (let i = 0; i < this.gantryStructMesh.count; i++) {
      this._placeGantry(dummy, i, this.gantryRecycler.indexToZ(gantryStartIndex + i));
    }
    this.gantryStructMesh.instanceMatrix.needsUpdate = true;
    this.gantryPanelMesh.instanceMatrix.needsUpdate = true;

    const billboardStartIndex = Math.floor(playerZ / this.billboardSpacing);
    this.billboardRecycler = new RingRecycler(this.billboardPoleMesh.count, this.billboardSpacing, billboardStartIndex);
    for (let i = 0; i < this.billboardPoleMesh.count; i++) {
      this._placeBillboard(dummy, i, this.billboardRecycler.indexToZ(billboardStartIndex + i));
    }
    this.billboardPoleMesh.instanceMatrix.needsUpdate = true;
    this.billboardPanelMesh.instanceMatrix.needsUpdate = true;
    // The small real-light pool re-parks itself every frame purely from
    // the current playerZ (see _updateStreetlights) — no reset needed.
  }

  // ------------------------------------------------------------------
  _buildMaterials() {
    const asphaltTex = this._buildAsphaltTexture();
    // map + vertexColors multiply together — the texture supplies fine
    // grain/noise detail, the baked vertex colors still distinguish
    // asphalt/shoulder/lane-lines/edge-lines within the same merged
    // geometry and single draw call.
    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: asphaltTex, roughness: 0.95 });
    this.railMat = new THREE.MeshStandardMaterial({ color: 0x2a2e38, metalness: 0.6, roughness: 0.4 });
    this.poleMat = new THREE.MeshStandardMaterial({
      color: 0x1c1e24, metalness: 0.5, roughness: 0.6,
      emissive: 0x0d3a42, emissiveIntensity: 1.1, // faint cyan neon tint — plain dark metal
      // was nearly invisible against the black sky (same issue class as the
      // traffic cars before headlights), leaving the lamp looking like it
      // floats with no visible pole beneath it. A dim glow keeps the pole
      // readable as a silhouette without competing with the lamp itself,
      // and reads as an intentional neon accent for the cyberpunk setting.
    });
    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a, emissive: 0xfff2c2, emissiveIntensity: 2.2, roughness: 0.4,
    });
    this.reflectorMat = new THREE.MeshStandardMaterial({
      color: 0x113338, emissive: 0x7ff6ff, emissiveIntensity: 3.2,
    });
    this.structureMat = new THREE.MeshStandardMaterial({ color: 0x23262e, metalness: 0.55, roughness: 0.5 });
  }

  /** Small tileable noise pattern so the road isn't a single flat vertex color up close. */
  _buildAsphaltTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    // Grayscale speckle around white — multiplied with vertexColors, so
    // mid-gray speckle darkens the surface slightly while pure white
    // areas leave the baked vertex color untouched.
    const imgData = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const n = 0.82 + Math.random() * 0.18; // stay light so it only subtly darkens, never washes out
      const v = Math.floor(255 * n);
      imgData.data[i] = v; imgData.data[i + 1] = v; imgData.data[i + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(this.roadWidth / 2.2, this.segmentLength / 2.2);
    return tex;
  }

  /** A single large static ground plane — without this, the skyline was floating over pure black void beyond the shoulder. */
  _buildGround(scene) {
    const size = 6000;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 1 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.y = -0.05; // just under the road surface, avoids z-fighting with the shoulder
    scene.add(this.ground);
  }

  // ---- Road (instanced) ----
  _buildRoadPool(scene, slotCount, aheadCount) {
    this.segmentsAhead = aheadCount;
    const roadGeo = this._buildSegmentGeometry();
    const railGeo = this._buildGuardrailGeometry();
    const reflectorGeo = this._buildReflectorClusterGeometry();

    this.roadRecycler = new RingRecycler(slotCount, this.segmentLength, 0);
    this.roadMesh = new THREE.InstancedMesh(roadGeo, this.roadMat, slotCount);
    this.railMesh = new THREE.InstancedMesh(railGeo, this.railMat, slotCount);
    this.reflectorMesh = new THREE.InstancedMesh(reflectorGeo, this.reflectorMat, slotCount);
    scene.add(this.roadMesh, this.railMesh, this.reflectorMesh);

    const dummy = new THREE.Object3D();
    for (let i = 0; i < slotCount; i++) {
      dummy.position.set(0, 0, this.roadRecycler.indexToZ(i));
      dummy.updateMatrix();
      this.roadMesh.setMatrixAt(i, dummy.matrix);
      this.railMesh.setMatrixAt(i, dummy.matrix);
      this.reflectorMesh.setMatrixAt(i, dummy.matrix);
    }
    this.roadMesh.instanceMatrix.needsUpdate = true;
    this.railMesh.instanceMatrix.needsUpdate = true;
    this.reflectorMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * A cluster of small glowing "cat's eye" reflectors along both
   * internal lane boundaries, covering one segment's length — reuses
   * the ROAD's own RingRecycler/indices rather than a separate pool
   * (same pattern as the guardrail mesh), since reflector positions are
   * tied 1:1 to segment position anyway. Kept as its own InstancedMesh
   * (not merged into the road surface) because it needs its own
   * emissive material — MeshStandardMaterial's emissive is per-material,
   * not per-vertex, same reason streetlight lamps are separate from poles.
   */
  _buildReflectorClusterGeometry() {
    const half = this.segmentLength / 2;
    const spacing = 12; // meters — roughly matches real reflector spacing
    const parts = [];
    for (let b = 1; b < this.laneCount; b++) {
      const bx = this.laneCenterX(b - 1) + this.laneWidth / 2;
      for (let z = -half + spacing / 2; z < half; z += spacing) {
        const dot = new THREE.BoxGeometry(0.09, 0.03, 0.14);
        dot.translate(bx, 0.016, z);
        parts.push(dot);
      }
    }
    return mergeGeometries(parts, false);
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
      this.reflectorMesh.setMatrixAt(c.slot, this._dummy.matrix);
    }
    this.roadMesh.instanceMatrix.needsUpdate = true;
    this.railMesh.instanceMatrix.needsUpdate = true;
    this.reflectorMesh.instanceMatrix.needsUpdate = true;
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

  // ---- Overhead gantry signs (sparse landmarks) ----
  _buildGantries(scene, options) {
    this.gantrySpacing = options.gantrySpacing ?? 420;
    const slotCount = options.gantrySlots ?? 4;
    this.gantryAhead = options.gantryAhead ?? 3;
    const poleHeight = 7.6;
    const halfSpan = this.roadWidth / 2 + 0.6;

    const structParts = [];
    for (const side of [-1, 1]) {
      const pole = new THREE.BoxGeometry(0.22, poleHeight, 0.22);
      pole.translate(side * halfSpan, poleHeight / 2, 0);
      structParts.push(withVertexColor(pole, 0x1b1e26));
    }
    const beam = new THREE.BoxGeometry(halfSpan * 2 + 0.4, 0.3, 0.3);
    beam.translate(0, poleHeight, 0);
    structParts.push(withVertexColor(beam, 0x1b1e26));
    const structGeo = mergeGeometries(structParts, false);
    const structMat = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.5, roughness: 0.5,
      emissive: 0x0d2a38, emissiveIntensity: 0.7, // same "stay visible against black sky" reasoning as the streetlight poles
    });

    const panelH = 1.5, panelW = halfSpan * 1.8;
    const panelGeo = new THREE.PlaneGeometry(panelW, panelH);
    panelGeo.rotateY(Math.PI); // face -Z, toward approaching traffic
    panelGeo.translate(0, poleHeight - 0.95, 0.16);
    const panelTex = this._buildGantrySignTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      map: panelTex, emissiveMap: panelTex, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.6,
    });

    this.gantryRecycler = new RingRecycler(slotCount, this.gantrySpacing, 0);
    this.gantryStructMesh = new THREE.InstancedMesh(structGeo, structMat, slotCount);
    this.gantryPanelMesh = new THREE.InstancedMesh(panelGeo, panelMat, slotCount);
    scene.add(this.gantryStructMesh, this.gantryPanelMesh);

    const dummy = new THREE.Object3D();
    for (let i = 0; i < slotCount; i++) {
      dummy.position.set(0, 0, this.gantryRecycler.indexToZ(i));
      dummy.updateMatrix();
      this.gantryStructMesh.setMatrixAt(i, dummy.matrix);
      this.gantryPanelMesh.setMatrixAt(i, dummy.matrix);
    }
    this.gantryStructMesh.instanceMatrix.needsUpdate = true;
    this.gantryPanelMesh.instanceMatrix.needsUpdate = true;
  }

  _buildGantrySignTexture() {
    const w = 512, h = 160;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#060a10';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#5ff7ff';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = '#5ff7ff';
    ctx.font = '700 34px Orbitron, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('HWY', 36, 68);
    ctx.font = '900 78px Orbitron, sans-serif';
    ctx.fillText('07', 34, 138);
    ctx.strokeStyle = 'rgba(95,247,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(190, 30); ctx.lineTo(190, h - 30); ctx.stroke();
    ctx.fillStyle = '#ff3ec4';
    ctx.font = '600 30px Orbitron, sans-serif';
    ctx.fillText('CENTRAL', 220, 68);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 24px Orbitron, sans-serif';
    ctx.fillText('DISTRICT', 220, 104);
    ctx.textAlign = 'left';
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }

  _placeGantry(dummy, slot, z) {
    dummy.position.set(0, 0, z);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    this.gantryStructMesh.setMatrixAt(slot, dummy.matrix);
    this.gantryPanelMesh.setMatrixAt(slot, dummy.matrix);
  }

  _updateGantries(carZ) {
    const changes = this.gantryRecycler.advanceTo(carZ, this.gantryAhead);
    if (changes.length === 0) return;
    for (const c of changes) this._placeGantry(this._dummy, c.slot, c.z);
    this.gantryStructMesh.instanceMatrix.needsUpdate = true;
    this.gantryPanelMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- Roadside billboards (sparse, alternating sides, just for atmosphere) ----
  _buildBillboards(scene, options) {
    this.billboardSpacing = options.billboardSpacing ?? 210;
    const slotCount = options.billboardSlots ?? 8;
    this.billboardAhead = options.billboardAhead ?? 5;
    const poleHeight = 5.2, panelW = 5.2, panelH = 3.1;
    this.billboardDistance = options.billboardDistance ?? this.roadWidth / 2 + 9;

    const poleGeo = new THREE.BoxGeometry(0.26, poleHeight, 0.26);
    poleGeo.translate(0, poleHeight / 2, 0);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x1b1e26, metalness: 0.5, roughness: 0.5,
      emissive: 0x2a0d2e, emissiveIntensity: 0.6,
    });

    const panelGeo = new THREE.PlaneGeometry(panelW, panelH);
    panelGeo.translate(0, poleHeight + panelH / 2 - 0.3, 0);
    const panelTex = this._buildBillboardTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      map: panelTex, emissiveMap: panelTex, emissive: 0xffffff, emissiveIntensity: 0.65, roughness: 0.6, side: THREE.DoubleSide,
    });

    this.billboardRecycler = new RingRecycler(slotCount, this.billboardSpacing, 0);
    this.billboardPoleMesh = new THREE.InstancedMesh(poleGeo, poleMat, slotCount);
    this.billboardPanelMesh = new THREE.InstancedMesh(panelGeo, panelMat, slotCount);
    scene.add(this.billboardPoleMesh, this.billboardPanelMesh);

    const dummy = new THREE.Object3D();
    for (let i = 0; i < slotCount; i++) {
      this._placeBillboard(dummy, i, this.billboardRecycler.indexToZ(i));
    }
    this.billboardPoleMesh.instanceMatrix.needsUpdate = true;
    this.billboardPanelMesh.instanceMatrix.needsUpdate = true;
  }

  _buildBillboardTexture() {
    const w = 512, h = 300;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0510';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ff3ec4';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff3ec4';
    ctx.font = '900 64px Orbitron, sans-serif';
    ctx.fillText('NEON', w / 2, 120);
    ctx.fillStyle = '#5ff7ff';
    ctx.font = '900 64px Orbitron, sans-serif';
    ctx.fillText('DRIFT', w / 2, 195);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '500 22px Orbitron, sans-serif';
    ctx.fillText('— ENERGY —', w / 2, 240);
    ctx.textAlign = 'left';
    return new THREE.CanvasTexture(canvas);
  }

  _placeBillboard(dummy, slot, z) {
    const side = Math.floor(z / this.billboardSpacing) % 2 === 0 ? -1 : 1;
    dummy.position.set(side * this.billboardDistance, 0, z);
    dummy.rotation.set(0, side === -1 ? Math.PI * 0.12 : -Math.PI * 0.12 + Math.PI, 0);
    dummy.updateMatrix();
    this.billboardPoleMesh.setMatrixAt(slot, dummy.matrix);
    this.billboardPanelMesh.setMatrixAt(slot, dummy.matrix);
  }

  _updateBillboards(carZ) {
    const changes = this.billboardRecycler.advanceTo(carZ, this.billboardAhead);
    if (changes.length === 0) return;
    for (const c of changes) this._placeBillboard(this._dummy, c.slot, c.z);
    this.billboardPoleMesh.instanceMatrix.needsUpdate = true;
    this.billboardPanelMesh.instanceMatrix.needsUpdate = true;
  }
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
