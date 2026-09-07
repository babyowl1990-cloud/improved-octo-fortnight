import * as THREE from 'three';

/**
 * HUDPanel.js
 * ------------------------------------------------------------------
 * IMPORTANT VR-SPECIFIC REASON THIS FILE EXISTS: the debug HUD used
 * while building the physics/camera systems was a plain HTML <div>
 * overlaid on the page. That works great on a flat monitor and is
 * USELESS in an actual VR headset — an immersive-vr WebXR session
 * renders only the 3D scene; regular DOM elements aren't part of that
 * render and won't be visible through the headset. Anything the
 * player needs to read in VR (speed, score, game-over screen) has to
 * be actual geometry in the scene. The standard, cheap way to do that
 * is exactly what's below: draw text onto a 2D canvas, upload it as a
 * texture on a plane mesh.
 *
 * Two panels:
 *   - `drivePanel`: small, low in the view, always visible while
 *     playing. Attached directly to the THREE.Camera (head-locked) so
 *     it works identically in cockpit or chase mode without extra
 *     bookkeeping.
 *   - `gameOverPanel`: larger, centered, hidden until ScoreSystem
 *     reports gameOver.
 *
 * COMFORT NOTE (same category of concern as CameraRig): a HUD that's
 * rigidly welded to the camera and fills a lot of the view can feel
 * uncomfortable for some VR players, since it moves with every head
 * turn rather than staying put in the world. Keeping it SMALL and in
 * the lower periphery (like a real car's dashboard cluster) is the
 * standard mitigation and what's done here. A dashboard-mounted,
 * world-locked HUD (attached to the car instead of the camera) would
 * be even more comfortable and is a reasonable next iteration — this
 * version favors simplicity for the foundational drop.
 *
 * PERFORMANCE NOTE: canvas redraw + texture upload isn't free every
 * single frame, so both panels redraw on a throttled interval rather
 * than every render call (except gameOver, which redraws immediately
 * on the transition so the summary appears without a visible delay).
 * ------------------------------------------------------------------
 */
export class HUDPanel {
  constructor(camera, options = {}) {
    this.camera = camera;
    this.redrawInterval = options.redrawInterval ?? 1 / 12; // Hz -> seconds
    this._redrawTimer = 0;
    this._wasGameOver = false;

    this._buildDrivePanel();
    this._buildGameOverPanel();
  }

  _buildDrivePanel() {
    this._driveCanvas = document.createElement('canvas');
    this._driveCanvas.width = 512;
    this._driveCanvas.height = 160;
    this._driveCtx = this._driveCanvas.getContext('2d');
    this._driveTex = new THREE.CanvasTexture(this._driveCanvas);

    const mat = new THREE.MeshBasicMaterial({ map: this._driveTex, transparent: true, depthTest: false });
    const geo = new THREE.PlaneGeometry(0.5, 0.5 * (160 / 512));
    this.drivePanel = new THREE.Mesh(geo, mat);
    this.drivePanel.position.set(0, -0.22, -0.9); // low-center, in front of the camera
    this.drivePanel.renderOrder = 999;
    this.camera.add(this.drivePanel);
  }

  _buildGameOverPanel() {
    this._overCanvas = document.createElement('canvas');
    this._overCanvas.width = 640;
    this._overCanvas.height = 400;
    this._overCtx = this._overCanvas.getContext('2d');
    this._overTex = new THREE.CanvasTexture(this._overCanvas);

    const mat = new THREE.MeshBasicMaterial({ map: this._overTex, transparent: true, depthTest: false });
    const geo = new THREE.PlaneGeometry(0.9, 0.9 * (400 / 640));
    this.gameOverPanel = new THREE.Mesh(geo, mat);
    this.gameOverPanel.position.set(0, 0, -1.2);
    this.gameOverPanel.renderOrder = 1000;
    this.gameOverPanel.visible = false;
    this.camera.add(this.gameOverPanel);
  }

  /** @param {number} dt @param {import('./VehiclePhysics.js').VehiclePhysics} car @param {import('./ScoreSystem.js').ScoreSystem} score */
  update(dt, car, score) {
    const justChangedGameOverState = score.gameOver !== this._wasGameOver;
    this._wasGameOver = score.gameOver;

    this._redrawTimer -= dt;
    if (this._redrawTimer > 0 && !justChangedGameOverState) return;
    this._redrawTimer = this.redrawInterval;

    this._drawDrivePanel(car, score);
    this.gameOverPanel.visible = score.gameOver;
    if (score.gameOver) this._drawGameOverPanel(score);
  }

  _drawDrivePanel(car, score) {
    const ctx = this._driveCtx;
    const w = this._driveCanvas.width, h = this._driveCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(5,10,14,0.55)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(126,247,255,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    ctx.fillStyle = '#7ef7ff';
    ctx.font = '600 40px ui-monospace, Menlo, monospace';
    ctx.fillText(`${car.speedKmh.toFixed(0)} km/h`, 24, 60);
    ctx.font = '400 24px ui-monospace, Menlo, monospace';
    ctx.fillText(`${car.speedMph.toFixed(0)} mph`, 24, 92);

    ctx.font = '400 26px ui-monospace, Menlo, monospace';
    ctx.fillText(`${score.distance.toFixed(0)} m`, 260, 60);
    ctx.fillStyle = score.multiplier > 1 ? '#ffd166' : '#7ef7ff';
    ctx.font = '600 30px ui-monospace, Menlo, monospace';
    ctx.fillText(`x${score.multiplier}  ${score.score}`, 260, 96);
    ctx.fillStyle = '#7ef7ff';
    ctx.font = '400 18px ui-monospace, Menlo, monospace';
    ctx.fillText('distance / near-miss score', 260, 122);

    this._driveTex.needsUpdate = true;
  }

  _drawGameOverPanel(score) {
    const ctx = this._overCtx;
    const w = this._overCanvas.width, h = this._overCanvas.height;
    const s = score.finalSummary ?? { score: score.score, distance: score.distance, nearMissCount: score.nearMissCount };

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(5,8,12,0.88)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ff3355';
    ctx.lineWidth = 4;
    ctx.strokeRect(4, 4, w - 8, h - 8);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff3355';
    ctx.font = '700 54px ui-monospace, Menlo, monospace';
    ctx.fillText('COLLISION', w / 2, 90);

    ctx.fillStyle = '#7ef7ff';
    ctx.font = '600 38px ui-monospace, Menlo, monospace';
    ctx.fillText(`Score: ${s.score}`, w / 2, 170);
    ctx.fillText(`Distance: ${s.distance.toFixed(0)} m`, w / 2, 218);
    ctx.font = '400 26px ui-monospace, Menlo, monospace';
    ctx.fillText(`Near misses: ${s.nearMissCount}`, w / 2, 260);

    ctx.font = '400 24px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#9fb0b8';
    ctx.fillText('Hold throttle to restart', w / 2, 330);
    ctx.textAlign = 'left';

    this._overTex.needsUpdate = true;
  }
}
