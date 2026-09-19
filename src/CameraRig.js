import * as THREE from 'three';

/**
 * CameraRig.js
 * ------------------------------------------------------------------
 * Drives the player's camera from the car's physics state. Two modes:
 *   - 'cockpit': camera sits at the seat position, rotates fully with
 *     the chassis (heading + roll + pitch). This is the more immersive
 *     option and, with the static dashboard reference below, the more
 *     VR-comfortable one.
 *   - 'chase': camera trails behind/above the car. Rotates with
 *     HEADING ONLY, not roll/pitch — a chase cam that banks and dives
 *     with the chassis is a well-known nausea trigger; keeping it
 *     upright while still cornering with the car is the standard fix.
 *
 * A CRITICAL VR-SPECIFIC DESIGN CHOICE: "camera shake" here NEVER
 * displaces the camera's position. Position-shake is exactly what
 * flat-screen racing games do for impact feel, and it's one of the
 * most reliable ways to make a VR player sick — the headset reports
 * "your head didn't move" while the image says otherwise, and that
 * mismatch is the actual mechanism behind simulator sickness. Instead,
 * G-force "intensity" is expressed as a small FOV pulse, which reads
 * as tension/speed without moving the world relative to your real
 * head. `comfort` (0..1) scales this — and everything else non-
 * essential — down to fully off for sensitive players.
 *
 * The cockpit dashboard/wheel silhouette is there for the same reason
 * (a fixed foreground reference is one of the most effective, well
 * documented ways to reduce VR motion sickness) — feel free to replace
 * it with a real interior model later, but keep SOMETHING static in
 * the cockpit view's foreground.
 *
 * WHY EVERY CAMERA ROTATION BELOW ADDS AN EXTRA Math.PI: the car's
 * body (VehiclePhysics + the chassis meshes in main.js/AITrafficController)
 * was built with its visual front at local +Z — that's where the
 * wheel labels, turn signals, and forward motion all agree the "front"
 * is. THREE.Camera, on the other hand, always looks down its own
 * local -Z by default — that's a fixed THREE.js convention, not
 * something this project chose. Using the car's raw heading quaternion
 * directly on the camera therefore points it at the car's REAR. The
 * fix is a fixed 180° (Math.PI) yaw added only to the camera's own
 * rotation — never to the chassis mesh rotation or to the physics
 * heading itself, both of which are already correct.
 * ------------------------------------------------------------------
 */
export class CameraRig {
  constructor(scene, camera, options = {}) {
    this.camera = camera;
    this.mode = 'cockpit';
    this.comfort = options.comfort ?? 1.0; // 0 = disable all extra FOV/shake effects

    this.playerRig = new THREE.Group();
    this.playerRig.add(camera);
    scene.add(this.playerRig);

    this.seatOffset = new THREE.Vector3(0, 1.05, -0.35);
    // Behind the car — negative Z, since the car's front is +Z (see
    // class doc). This was previously positive, which put the "chase"
    // camera ahead of the car looking back at it instead of trailing it.
    this.chaseOffset = new THREE.Vector3(0, 2.2, -6.5);
    this.chaseFollowSharpness = options.chaseFollowSharpness ?? 4.0;

    this._chaseSmoothPos = new THREE.Vector3();
    this._chaseSmoothQuat = new THREE.Quaternion();
    this._chaseInitialized = false;

    this.baseFov = options.baseFov ?? 90;
    this.maxFovKick = options.maxFovKick ?? 10; // degrees added at speedForMaxFov
    this.speedForMaxFov = options.speedForMaxFov ?? 60; // m/s
    this._shakeClock = 0;

    // Scratch objects reused every frame instead of allocated fresh —
    // update() runs unconditionally every rendered frame for the whole
    // session (up to ~90x/sec in VR), and was allocating 5-9 new
    // Vector3/Quaternion/Euler objects per call. Individually cheap,
    // but sustained over a long play session that's real, compounding
    // GC pressure — exactly the kind of thing that can present as
    // creeping stutter/hitching the longer a session runs. Same
    // "preallocate and mutate" pattern already used for HighwaySystem's
    // per-frame instance-matrix updates.
    this._scratchCarPos = new THREE.Vector3();
    this._scratchCarEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scratchCarQuat = new THREE.Quaternion();
    this._scratchCameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scratchCameraQuat = new THREE.Quaternion();
    this._scratchHeadingEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scratchHeadingQuat = new THREE.Quaternion();
    this._scratchCameraHeadingEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scratchCameraHeadingQuat = new THREE.Quaternion();
    this._scratchOffset = new THREE.Vector3();

    this._buildCockpitReference();
  }

  _buildCockpitReference() {
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.7 });
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.5), dashMat);
    dash.position.set(0, -0.35, -0.55);

    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0e12, roughness: 0.5 });
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.028, 8, 20), wheelMat);
    wheel.position.set(0, -0.24, -0.52);
    wheel.rotation.x = Math.PI / 2.3;

    this.cockpitReference = new THREE.Group();
    this.cockpitReference.add(dash, wheel);
    this.playerRig.add(this.cockpitReference);
  }

  toggleMode() {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
  }

  /**
   * Call after teleporting the car (e.g. a post-collision restart) so
   * the chase camera snaps to the new position instead of smoothly
   * gliding there from wherever it was — which, across a restart that
   * can teleport hundreds of meters, would otherwise look like the
   * camera flying across the map before catching up.
   */
  resetFollow() {
    this._chaseInitialized = false;
  }

  /**
   * @param {import('./VehiclePhysics.js').VehiclePhysics} car
   * @param {number} dt - real elapsed seconds since last call (render-frame time, not physics dt)
   */
  update(car, dt) {
    const carPos = this._scratchCarPos.set(car.position.x, 0, car.position.z);
    // The car's TRUE orientation — correct as-is, used for POSITION
    // offsets only (seat/chase offsets are physical points on the car
    // and must rotate with its real heading, not the camera's flipped one).
    this._scratchCarEuler.set(car.pitchAngle, car.heading, car.rollAngle, 'YXZ');
    const carQuat = this._scratchCarQuat.setFromEuler(this._scratchCarEuler);
    // The camera's OWN rotation — same orientation plus the 180° fix
    // documented at the top of this file, so it looks at the car's
    // front instead of its rear.
    this._scratchCameraEuler.set(car.pitchAngle, car.heading + Math.PI, car.rollAngle, 'YXZ');
    const cameraQuat = this._scratchCameraQuat.setFromEuler(this._scratchCameraEuler);

    if (this.mode === 'cockpit') {
      this.cockpitReference.visible = true;
      const seatWorld = this._scratchOffset.copy(this.seatOffset).applyQuaternion(carQuat).add(carPos);
      this.playerRig.position.copy(seatWorld);
      this.playerRig.quaternion.copy(cameraQuat);
    } else {
      this.cockpitReference.visible = false;
      this._scratchHeadingEuler.set(0, car.heading, 0, 'YXZ');
      const headingQuat = this._scratchHeadingQuat.setFromEuler(this._scratchHeadingEuler);
      this._scratchCameraHeadingEuler.set(0, car.heading + Math.PI, 0, 'YXZ');
      const cameraHeadingQuat = this._scratchCameraHeadingQuat.setFromEuler(this._scratchCameraHeadingEuler);
      const desired = this._scratchOffset.copy(this.chaseOffset).applyQuaternion(headingQuat).add(carPos);

      if (!this._chaseInitialized) {
        this._chaseSmoothPos.copy(desired);
        this._chaseSmoothQuat.copy(cameraHeadingQuat);
        this._chaseInitialized = true;
      }
      const t = 1 - Math.exp(-this.chaseFollowSharpness * Math.max(dt, 0));
      this._chaseSmoothPos.lerp(desired, t);
      this._chaseSmoothQuat.slerp(cameraHeadingQuat, t);

      this.playerRig.position.copy(this._chaseSmoothPos);
      this.playerRig.quaternion.copy(this._chaseSmoothQuat);
    }

    this._updateFov(car, dt);
  }

  _updateFov(car, dt) {
    this._shakeClock += dt;
    const speedT = THREE.MathUtils.clamp(car.speedMs / this.speedForMaxFov, 0, 1);
    let fov = this.baseFov + speedT * this.maxFovKick * this.comfort;

    if (this.comfort > 0) {
      const gMag = Math.min(1, Math.hypot(car.longitudinalG, car.lateralG) / 1.2);
      const pulse = Math.sin(this._shakeClock * 47.0) * gMag * 0.15 * this.comfort;
      fov += pulse;
    }

    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
}
