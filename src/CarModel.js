import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withVertexColor } from './HighwaySystem.js';

/**
 * CarModel.js
 * ------------------------------------------------------------------
 * A better car silhouette than "one box on four cylinders", built the
 * same way the road surface is: several primitive shapes merged into
 * ONE geometry with per-part vertex colors, so the whole car body is
 * still a single draw call regardless of how many parts make up its
 * shape. Lower body (paint color) + inset cabin (tinted glass color)
 * + a thin roof cap + mirrors reads as an actual car silhouette from
 * a normal driving distance, not just a rectangular block.
 *
 * Overall footprint is kept at 1.8m wide x 4.2m long to match the
 * collision half-width/half-length constants already tuned in
 * AITrafficController.js — this file only changes what the car looks
 * like, not its size.
 *
 * Lights (headlights/taillights) are built separately from the merged
 * body, since they need their own always-on emissive materials —
 * MeshStandardMaterial's emissive is per-material, not per-vertex,
 * same reason the road's streetlight lamps are separate from their poles.
 * ------------------------------------------------------------------
 */

const WHEEL_OFFSETS = [
  [0.86, 0.33, 1.35], [-0.86, 0.33, 1.35],
  [0.86, 0.33, -1.35], [-0.86, 0.33, -1.35],
];

/**
 * @param {number} paintColorHex
 * @param {object} [options]
 * @param {number} [options.glassColor] tinted cabin windows
 * @param {number} [options.wheelColor]
 * @returns {THREE.BufferGeometry} one merged, vertex-colored geometry — body, cabin, roof, mirrors, and all four wheels
 */
export function buildCarBodyGeometry(paintColorHex, options = {}) {
  const glassColor = options.glassColor ?? 0x0a0d14;
  const wheelColor = options.wheelColor ?? 0x101010;
  const parts = [];

  const body = new THREE.BoxGeometry(1.8, 0.5, 4.2);
  body.translate(0, 0.42, 0);
  parts.push(withVertexColor(body, paintColorHex));

  const cabin = new THREE.BoxGeometry(1.5, 0.38, 2.1);
  cabin.translate(0, 0.86, -0.15);
  parts.push(withVertexColor(cabin, glassColor));

  const roof = new THREE.BoxGeometry(1.42, 0.06, 1.9);
  roof.translate(0, 1.08, -0.15);
  parts.push(withVertexColor(roof, paintColorHex));

  for (const side of [-1, 1]) {
    const mirror = new THREE.BoxGeometry(0.1, 0.08, 0.2);
    mirror.translate(side * 0.95, 0.75, 0.55);
    parts.push(withVertexColor(mirror, paintColorHex));
  }

  const frontBumper = new THREE.BoxGeometry(1.75, 0.16, 0.22);
  frontBumper.translate(0, 0.2, 2.04);
  parts.push(withVertexColor(frontBumper, 0x15161a));
  const rearBumper = new THREE.BoxGeometry(1.75, 0.16, 0.22);
  rearBumper.translate(0, 0.2, -2.04);
  parts.push(withVertexColor(rearBumper, 0x15161a));

  for (const [x, y, z] of WHEEL_OFFSETS) {
    const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(x, y, z);
    parts.push(withVertexColor(wheel, wheelColor));
  }

  return mergeGeometries(parts, false);
}

/**
 * Adds always-on headlight (front, warm white) and taillight (rear,
 * red) meshes to `group`. Both car types get these — real cars are
 * only reliably visible at night because of their own lights, not
 * because of ambient scene lighting (same lesson learned from traffic
 * being nearly invisible before this was added there).
 */
export function addCarLights(group) {
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff6d8, emissiveIntensity: 2.5 });
  const taillightMat = new THREE.MeshStandardMaterial({ color: 0xff2233, emissive: 0xff2233, emissiveIntensity: 2.5 });
  const lampGeo = new THREE.BoxGeometry(0.16, 0.1, 0.06);
  for (const x of [-0.7, 0.7]) {
    const headlight = new THREE.Mesh(lampGeo, headlightMat);
    headlight.position.set(x, 0.42, 2.12);
    const taillight = new THREE.Mesh(lampGeo, taillightMat);
    taillight.position.set(x, 0.42, -2.12);
    group.add(headlight, taillight);
  }
}
