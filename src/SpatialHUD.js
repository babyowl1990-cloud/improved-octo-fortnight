import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * SpatialHUD.js
 * ------------------------------------------------------------------
 * Cyberpunk/terminal-styled HUD, built as actual spatial (3D) elements
 * rather than one flat texture:
 *   - Each panel (speed, score, game-over) is canvas-texture content
 *     framed by REAL corner-bracket geometry sitting slightly in front
 *     of it — genuine depth/parallax, not a drawn decoration. That's
 *     what makes this "spatial" rather than just a reskinned overlay.
 *   - Speed/score panels sit low-peripheral and angled slightly inward
 *     toward the driver, like a dashboard cluster — same VR-comfort
 *     reasoning as the previous HUD (small, off-center, not filling
 *     the view) plus a bit of genuine 3D arrangement.
 *   - Everything animates: a boot-in sequence (corner brackets/panels
 *     pop in with a slight overshoot) on start and on every restart, a
 *     looping scanline sweep, a "punch" scale pulse on each near-miss,
 *     and an RGB-split glitch burst the instant a collision happens.
 *
 * PERFORMANCE NOTE: canvas redraw (the actual text/graphics content)
 * stays throttled to ~12Hz like the previous HUD — redrawing a canvas
 * and re-uploading it as a texture isn't free. Transform animations
 * (scale punch, glitch jitter, boot-in) are cheap (just mesh
 * position/scale, no canvas involved) and update every frame for
 * smoothness — same "preallocate, mutate, don't reallocate" discipline
 * as CameraRig/HighwaySystem elsewhere in this project.
 * ------------------------------------------------------------------
 */

const CYAN = '#5ff7ff';
const CYAN_DIM = 'rgba(95,247,255,0.35)';
const MAGENTA = '#ff3ec4';
const DANGER = '#ff3355';
const INK = 'rgba(4,8,10,0.72)';
const FONT = 'Orbitron, ui-monospace, monospace';

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  const x = Math.min(Math.max(t, 0), 1) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

export class SpatialHUD {
  constructor(camera, options = {}) {
    this.camera = camera;
    this.redrawInterval = options.redrawInterval ?? 1 / 12;
    this._redrawTimer = 0;
    this._wasGameOver = false;
    this._wasSettingsOpen = false;
    this._settingsAnimClock = 0;
    this._clock = 0;

    this._scorePunch = 0;   // 0..1, decays — near-miss "punch" scale pulse
    this._glitchClock = -1; // <0 = inactive; counts up from 0 while a collision glitch plays
    this._bootClock = 0;    // counts up from 0 to BOOT_DURATION on (re)start

    this.GLITCH_DURATION = 0.45;
    this.BOOT_DURATION = 0.55;

    // Trigger the (small, local) font files loading as early as
    // possible. Not required for correctness — the throttled redraw
    // loop will just pick up the real font a frame or two after it's
    // ready, self-correcting from a fallback font automatically — but
    // this shaves off that gap.
    if (typeof document !== 'undefined' && document.fonts?.load) {
      for (const spec of ['500 20px Orbitron', '700 20px Orbitron', '900 20px Orbitron']) {
        document.fonts.load(spec).catch(() => {});
      }
    }

    this.speedPanel = this._buildPanel({
      canvasW: 380, canvasH: 300, worldW: 0.38, worldH: 0.30,
      x: -0.30, y: -0.19, z: -0.85, rotY: 0.16, frameColor: CYAN,
    });
    this.scorePanel = this._buildPanel({
      canvasW: 380, canvasH: 300, worldW: 0.38, worldH: 0.30,
      x: 0.30, y: -0.19, z: -0.85, rotY: -0.16, frameColor: MAGENTA,
    });
    this.gameOverPanel = this._buildPanel({
      canvasW: 720, canvasH: 460, worldW: 0.72, worldH: 0.46,
      x: 0, y: 0.02, z: -1.15, rotY: 0, frameColor: DANGER,
    });
    this.gameOverPanel.group.visible = false;

    this.settingsPanel = this._buildPanel({
      canvasW: 620, canvasH: 520, worldW: 0.5, worldH: 0.42,
      x: 0, y: 0.02, z: -1.0, rotY: 0, frameColor: CYAN,
    });
    this.settingsPanel.group.visible = false;

    this.bootIn();
  }

  /** Replays the panels' boot-in animation — call on first load and after every restart. */
  bootIn() {
    this._bootClock = 0;
  }

  /** Call once when a near-miss is scored — triggers the score panel's punch pulse. */
  pulseScore() {
    this._scorePunch = 1;
  }

  // ------------------------------------------------------------------
  _buildPanel({ canvasW, canvasH, worldW, worldH, x, y, z, rotY, frameColor }) {
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);

    const screenMat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), screenMat);
    // renderOrder must be set on the actual mesh, not the parent Group —
    // WebGLRenderLists reads `object.renderOrder` straight off the
    // renderable object being queued, it does not inherit from an
    // ancestor. Setting it only on `group` below did nothing; screen and
    // frame both silently fell back to the default (0) and their draw
    // order relative to each other was left to an unreliable transparent-
    // pass distance sort — two nearly-coplanar transparent surfaces with
    // depthTest off is exactly the recipe for flicker/wrong-layering.
    screen.renderOrder = 999;

    const frame = this._buildBracketFrame(worldW, worldH, frameColor);
    frame.position.z = 0.006; // slightly toward the camera than the screen -> real, visible depth
    frame.renderOrder = 1000; // explicitly after the screen, so brackets always draw on top of it

    const group = new THREE.Group();
    group.add(screen, frame);
    group.position.set(x, y, z);
    group.rotation.y = rotY;
    this.camera.add(group);

    return { group, screen, frame, canvas, ctx, texture, worldW, worldH };
  }

  /** A glowing L-bracket at each of the four corners — real geometry, not drawn. */
  _buildBracketFrame(worldW, worldH, colorHex) {
    const armLen = Math.min(worldW, worldH) * 0.26;
    const thickness = Math.max(worldW, worldH) * 0.012;
    const hw = worldW / 2, hh = worldH / 2;

    const parts = [];
    const addArm = (cx, cz, w, h) => {
      const g = new THREE.BoxGeometry(w, h, thickness);
      g.translate(cx, cz, 0);
      parts.push(g);
    };
    // Four corners, each an "L" made of a horizontal + vertical arm.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const cornerX = sx * hw, cornerY = sy * hh;
        addArm(cornerX - sx * armLen / 2, cornerY, armLen, thickness);
        addArm(cornerX, cornerY - sy * armLen / 2, thickness, armLen);
      }
    }
    const geometry = mergeGeometries(parts, false);
    const material = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, depthTest: false });
    return new THREE.Mesh(geometry, material);
  }

  // ------------------------------------------------------------------
  /** @param {number} dt @param {import('./VehiclePhysics.js').VehiclePhysics} car @param {import('./ScoreSystem.js').ScoreSystem} score @param {boolean} [settingsOpen] @param {import('./CarSettings.js').CarSettings} [settings] */
  update(dt, car, score, settingsOpen = false, settings = null) {
    this._clock += dt;

    // ---- Transform animations: run every frame, cheap (no canvas) ----
    const bootT = Math.min(this._bootClock / this.BOOT_DURATION, 1);
    this._bootClock += dt;
    const bootScale = Math.max(easeOutBack(bootT), 0.001);

    this._scorePunch *= Math.exp(-dt * 10);
    const scorePunchScale = 1 + this._scorePunch * 0.16;

    if (this._glitchClock >= 0) {
      this._glitchClock += dt;
      if (this._glitchClock > this.GLITCH_DURATION) this._glitchClock = -1;
    }

    this.speedPanel.group.scale.setScalar(bootScale);
    this.scorePanel.group.scale.setScalar(bootScale * scorePunchScale);

    if (score.gameOver) {
      const goT = Math.min(this._glitchClock < 0 ? 1 : this._glitchClock / this.GLITCH_DURATION, 1);
      this.gameOverPanel.group.scale.setScalar(Math.max(easeOutBack(goT), 0.001));
      if (this._glitchClock >= 0) {
        const jitter = (1 - this._glitchClock / this.GLITCH_DURATION);
        this.gameOverPanel.group.position.x = (Math.random() - 0.5) * 0.02 * jitter;
        this.gameOverPanel.group.position.y = 0.02 + (Math.random() - 0.5) * 0.015 * jitter;
      } else {
        this.gameOverPanel.group.position.x = 0;
        this.gameOverPanel.group.position.y = 0.02;
      }
    }

    if (settingsOpen && !this._wasSettingsOpen) this._settingsAnimClock = 0;
    if (settingsOpen) {
      this._settingsAnimClock += dt;
      const t = Math.min(this._settingsAnimClock / this.BOOT_DURATION, 1);
      this.settingsPanel.group.scale.setScalar(Math.max(easeOutBack(t), 0.001));
    }

    // ---- Canvas redraw: throttled ----
    const justChangedGameOverState = score.gameOver !== this._wasGameOver;
    if (justChangedGameOverState && score.gameOver) this._glitchClock = 0;
    this._wasGameOver = score.gameOver;
    const justChangedSettingsState = settingsOpen !== this._wasSettingsOpen;
    this._wasSettingsOpen = settingsOpen;

    this._redrawTimer -= dt;
    if (this._redrawTimer > 0 && !justChangedGameOverState && !justChangedSettingsState) return;
    this._redrawTimer = this.redrawInterval;

    this._drawSpeedPanel(car);
    this._drawScorePanel(score);
    this.gameOverPanel.group.visible = score.gameOver;
    if (score.gameOver) this._drawGameOverPanel(score);
    this.settingsPanel.group.visible = settingsOpen;
    if (settingsOpen && settings) this._drawSettingsPanel(settings);
  }

  // ------------------------------------------------------------------
  _drawPanelChrome(ctx, w, h, accentColor) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, w, h);

    // faint tech grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 24) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
    for (let gy = 0; gy < h; gy += 24) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

    // scanline sweep
    const period = 2.2;
    const sweepY = ((this._clock % period) / period) * h;
    const grad = ctx.createLinearGradient(0, sweepY - 18, 0, sweepY + 18);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, sweepY - 18, w, 36);

    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.globalAlpha = 1;
  }

  _drawSpeedPanel(car) {
    const { ctx, canvas } = this.speedPanel;
    const w = canvas.width, h = canvas.height;
    this._drawPanelChrome(ctx, w, h, CYAN_DIM);

    ctx.textAlign = 'center';
    ctx.fillStyle = CYAN;
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText('SPEED', w / 2, 34);

    ctx.font = `900 68px ${FONT}`;
    ctx.fillStyle = '#eafffe';
    ctx.fillText(car.speedKmh.toFixed(0), w / 2, 128);
    ctx.font = `500 18px ${FONT}`;
    ctx.fillStyle = CYAN;
    ctx.fillText('KM/H', w / 2, 154);

    // speed arc gauge (0 to a reasonable top speed reference)
    const cx = w / 2, cy = h - 70, radius = 84;
    const topSpeedRef = 240;
    const frac = Math.min(car.speedKmh / topSpeedRef, 1);
    const start = Math.PI * 0.78, span = Math.PI * 1.44;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(95,247,255,0.18)';
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(cx, cy, radius, start, start + span); ctx.stroke();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(cx, cy, radius, start, start + span * frac); ctx.stroke();

    ctx.font = `500 15px ${FONT}`;
    ctx.fillStyle = 'rgba(234,255,254,0.85)';
    ctx.fillText(car.speedMph.toFixed(0) + ' MPH', cx, cy + 5);
    ctx.textAlign = 'left';

    this.speedPanel.texture.needsUpdate = true;
  }

  _drawScorePanel(score) {
    const { ctx, canvas } = this.scorePanel;
    const w = canvas.width, h = canvas.height;
    this._drawPanelChrome(ctx, w, h, 'rgba(255,62,196,0.35)');

    ctx.textAlign = 'center';
    ctx.fillStyle = MAGENTA;
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText('SCORE', w / 2, 34);

    ctx.font = `900 56px ${FONT}`;
    ctx.fillStyle = '#ffeafa';
    ctx.fillText(String(score.score), w / 2, 100);

    const multColor = score.multiplier > 1 ? MAGENTA : 'rgba(255,234,250,0.5)';
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = multColor;
    ctx.fillText('×' + score.multiplier, w / 2, 142);

    ctx.font = `500 16px ${FONT}`;
    ctx.fillStyle = 'rgba(255,234,250,0.7)';
    ctx.fillText('DISTANCE', w / 2, 200);
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = '#ffeafa';
    ctx.fillText(score.distance.toFixed(0) + ' m', w / 2, 236);

    ctx.textAlign = 'left';
    this.scorePanel.texture.needsUpdate = true;
  }

  _drawGameOverPanel(score) {
    const { ctx, canvas } = this.gameOverPanel;
    const w = canvas.width, h = canvas.height;
    const s = score.finalSummary ?? { score: score.score, distance: score.distance, nearMissCount: score.nearMissCount };

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,3,5,0.85)';
    ctx.fillRect(0, 0, w, h);
    for (let gx = 0; gx < w; gx += 24) { ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }

    const inGlitch = this._glitchClock >= 0 && this._glitchClock < this.GLITCH_DURATION;
    const glitchAmt = inGlitch ? (1 - this._glitchClock / this.GLITCH_DURATION) : 0;

    ctx.textAlign = 'center';
    ctx.font = `900 58px ${FONT}`;
    const titleY = 92;
    if (glitchAmt > 0.02) {
      // RGB-split glitch burst — cheap fake-chromatic-aberration by
      // drawing the same text three times, offset and tinted.
      const off = glitchAmt * 6;
      ctx.fillStyle = 'rgba(255,40,90,0.8)'; ctx.fillText('COLLISION', w / 2 - off, titleY);
      ctx.fillStyle = 'rgba(95,247,255,0.8)'; ctx.fillText('COLLISION', w / 2 + off, titleY);
    }
    ctx.fillStyle = DANGER;
    ctx.fillText('COLLISION', w / 2, titleY);

    ctx.font = `500 20px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('— SYSTEM HALT —', w / 2, 128);

    ctx.font = `700 34px ${FONT}`;
    ctx.fillStyle = CYAN;
    ctx.fillText('SCORE  ' + s.score, w / 2, 210);
    ctx.font = `500 24px ${FONT}`;
    ctx.fillStyle = 'rgba(234,255,254,0.85)';
    ctx.fillText('DISTANCE  ' + s.distance.toFixed(0) + ' m', w / 2, 254);
    ctx.fillText('NEAR MISSES  ' + s.nearMissCount, w / 2, 290);

    ctx.font = `500 20px ${FONT}`;
    ctx.fillStyle = MAGENTA;
    ctx.fillText('HOLD THROTTLE TO RESTART', w / 2, 360);

    ctx.strokeStyle = DANGER;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

    this.gameOverPanel.texture.needsUpdate = true;
  }

  _drawSettingsPanel(settings) {
    const { ctx, canvas } = this.settingsPanel;
    const w = canvas.width, h = canvas.height;
    this._drawPanelChrome(ctx, w, h, CYAN_DIM);

    ctx.textAlign = 'center';
    ctx.fillStyle = CYAN;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText('CAR SETTINGS', w / 2, 52);
    ctx.font = `500 15px ${FONT}`;
    ctx.fillStyle = 'rgba(234,255,254,0.55)';
    ctx.fillText('UP/DOWN SELECT · LEFT/RIGHT ADJUST · M TO CLOSE', w / 2, 76);

    const rows = [
      ['GRIP', settings.grip.name],
      ['PAINT', settings.paint.name],
      ['COMFORT', settings.comfort.name],
      ['VIEW', settings.view],
    ];
    const rowH = 88, top = 118;
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      const selected = i === settings.selectedRow;
      if (selected) {
        ctx.fillStyle = 'rgba(95,247,255,0.12)';
        ctx.fillRect(24, y - 34, w - 48, 62);
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 2;
        ctx.strokeRect(24, y - 34, w - 48, 62);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = selected ? CYAN : 'rgba(234,255,254,0.6)';
      ctx.font = `500 20px ${FONT}`;
      ctx.fillText(label, 48, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = selected ? '#ffffff' : 'rgba(234,255,254,0.85)';
      ctx.font = `700 26px ${FONT}`;
      ctx.fillText(String(value), w - 48, y + 2);
      if (selected) {
        ctx.font = `700 22px ${FONT}`;
        ctx.fillText('‹', w - 48 - ctx.measureText(String(value)).width - 22, y + 2);
        ctx.textAlign = 'left';
        ctx.fillText('›', 48 + ctx.measureText(label).width + 14, y + 2);
      }
    });
    ctx.textAlign = 'left';

    this.settingsPanel.texture.needsUpdate = true;
  }
}
