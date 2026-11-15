/**
 * VRPassthrough - Mixed reality on the seabed
 *
 * When `vr.passthroughOnSeabed` is enabled and the headset supports it, the
 * VR session runs as an `immersive-ar` session. While the viewer is swimming
 * it looks exactly like VR: an opaque water backdrop hides the room. When the
 * viewer comes down onto the sand, the backdrop and fog fade out so the real
 * room shows through and the wreck stands around them at full scale, with the
 * sand at their real floor. Rising off the sand fades back into VR.
 *
 * "Standing on the sand" means the VR dolly (which sits on the viewer's real
 * floor, in the local-floor reference space) is at the seabed height under
 * them. The seabed is a plane fitted through the lowest points round the edge
 * of the scan, so walking over the wreck doesn't lift you onto its deck.
 */

import * as THREE from 'three';

const DEFAULTS = {
  landHeight: 0.15,   // dolly within this of the sand counts as landed (m)
  liftHeight: 0.4,    // rise this far off the sand to go back to VR (m)
  fadeSeconds: 0.6,   // backdrop and fog fade time
  sandBand: 0.5,      // local sand further than this from the fitted plane is ignored (m)
  eyeHeight: null,    // eyes this far above the sand when landed (m); null = your own height
  backdropRadius: 500 // base size; scaled each frame to sit inside the far plane
};

export class VRPassthrough {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera - VR camera; its parent is the dolly
   * @param {Function} getModels - returns the loaded model roots
   * @param {Object} [options]
   */
  constructor(renderer, scene, camera, getModels, options = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.getModels = getModels;
    this.options = { ...DEFAULTS, ...options };

    this.active = false;      // this session can show the room
    this.landed = false;      // standing on the sand
    this.blend = 0;           // 0 = VR, 1 = room fully showing
    this.seabed = null;       // { a, b, c } for y = a·x + b·z + c
    this.seabedOverride = Number.isFinite(options.seabedHeight) ? options.seabedHeight : null;
    this._lift = 0;
    this._lastY = 0;
    this._standOff = 0;
    this._savedFog = null;
    this._modelKey = null;

    this.onChange = null;     // (landed: boolean) => void

    this.backdrop = this._makeBackdrop();
    this.scene.add(this.backdrop);
  }

  setCamera(camera) {
    this.camera = camera;
  }

  /** Fix the sand height instead of estimating it from the scan. */
  setSeabedHeight(y) {
    this.seabedOverride = Number.isFinite(y) ? y : null;
  }

  /** Re-estimate the seabed, e.g. after the model has been moved or levelled. */
  refreshSeabed() {
    this.seabed = null;
    this._modelKey = null;
  }

  isPassthrough() {
    return this.active && this.landed;
  }

  /** Called when an XR session starts. Only alpha-blend sessions can show the room. */
  sessionStarted(session) {
    const mode = session?.environmentBlendMode;
    this.active = !!session && session.belowjsPassthrough === true && mode !== 'opaque';
    this.landed = false;
    this.blend = 0;
    this._lift = 0;
    this.refreshSeabed();
    this.backdrop.visible = this.active;
  }

  sessionEnded() {
    const wasLanded = this.landed;
    this.active = false;
    this.landed = false;
    this.blend = 0;
    this.backdrop.visible = false;
    if (wasLanded) this.onChange?.(false);
  }

  /** After locomotion each frame: land on, follow, or lift off the sand. */
  update(deltaTime) {
    if (!this.active) return;
    const dolly = this.camera?.parent;
    if (!dolly) return;

    const sand = this._sandHeightAt(dolly.position.x, dolly.position.z);
    if (sand !== null) {
      if (this.landed) {
        // Walk on the sand. Only your own upward movement since last frame
        // counts towards lifting off, not the sand sloping away under you;
        // pushing down cancels it.
        const rise = dolly.position.y - this._lastY;
        if (rise > 0) this._lift += rise;
        else if (rise < 0) this._lift = 0;
        if (this._lift > this.options.liftHeight) {
          this.landed = false;
          this._lift = 0;
          this.onChange?.(false);
        } else {
          dolly.position.y = sand + this._standOff;
          this._lastY = dolly.position.y;
        }
      } else {
        const standOff = this._standOffNow();
        if (dolly.position.y - sand <= standOff + this.options.landHeight) {
          this.landed = true;
          this._lift = 0;
          this._standOff = standOff;
          dolly.position.y = sand + standOff;
          this._lastY = dolly.position.y;
          this.onChange?.(true);
        }
      }
    }

    const target = this.landed ? 1 : 0;
    const step = (deltaTime || 0) / Math.max(this.options.fadeSeconds, 0.01);
    this.blend = target > this.blend ? Math.min(target, this.blend + step) : Math.max(target, this.blend - step);
  }

  /** Just before rendering: match the backdrop to the water and thin the fog. */
  beforeRender() {
    if (!this.active) return;

    // The camera in the rig, which three updates from the headset. The XR
    // camera is only in room space until three renders, after this.
    const eye = this.camera || this.renderer.xr.getCamera();
    eye.getWorldPosition(this.backdrop.position);
    // BelowJS fits the far plane to each model, so keep the water just inside it.
    const far = this.camera?.far || this.options.backdropRadius * 2;
    this.backdrop.scale.setScalar(Math.min(far * 0.9, this.options.backdropRadius * 4) / this.options.backdropRadius);

    const material = this.backdrop.material;
    const background = this.scene.background;
    if (background?.isTexture) {
      if (material.map !== background) {
        material.map = background;
        material.color.set(0xffffff);
        material.needsUpdate = true;
      }
    } else {
      if (material.map) {
        material.map = null;
        material.needsUpdate = true;
      }
      if (background?.isColor) material.color.copy(background);
      else if (this.scene.fog?.color) material.color.copy(this.scene.fog.color);
    }
    material.opacity = 1 - this.blend;
    this.backdrop.visible = this.blend < 1;

    // The backdrop stands in for the scene background. three still draws a
    // texture background in an alpha-blend session (as an opaque box round
    // the viewer) unless the headset is doing depth sensing, which would hide
    // the room, so take it away for the frame.
    this._savedBackground = background;
    this.scene.background = null;

    // Fade the fog with the backdrop. Only its numbers change, so no shaders
    // recompile; the values are put back after the frame.
    const fog = this.scene.fog;
    this._savedFog = null;
    if (fog && this.blend > 0) {
      const keep = 1 - this.blend;
      if (fog.isFogExp2) {
        this._savedFog = { fog, density: fog.density };
        fog.density *= keep;
      } else if (fog.isFog) {
        this._savedFog = { fog, near: fog.near, far: fog.far };
        const stretch = keep > 0.001 ? 1 / keep : 1e6;
        fog.near *= stretch;
        fog.far *= stretch;
      }
    }
  }

  afterRender() {
    if (this._savedBackground !== undefined) {
      if (this.scene.background === null) this.scene.background = this._savedBackground;
      this._savedBackground = undefined;
    }
    const saved = this._savedFog;
    if (!saved) return;
    if (saved.density !== undefined) saved.fog.density = saved.density;
    if (saved.near !== undefined) {
      saved.fog.near = saved.near;
      saved.fog.far = saved.far;
    }
    this._savedFog = null;
  }

  dispose() {
    this.scene.remove(this.backdrop);
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
  }

  _makeBackdrop() {
    // A sphere's UVs are equirectangular, so an equirect background texture
    // maps onto it the same way the desktop background shows it.
    const geometry = new THREE.SphereGeometry(this.options.backdropRadius, 48, 24);
    const material = new THREE.MeshBasicMaterial({
      color: 0x001122,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'BelowJS VR water backdrop';
    mesh.renderOrder = -1000;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.visible = false;
    return mesh;
  }

  /**
   * How far above the sand the rig stands when landed. With no eyeHeight it
   * is 0: your real floor is the sand and you see from your own height. With
   * eyeHeight, the rig is raised (or lowered) so your eyes are that far above
   * the sand. It is measured from your head height as you land and then held,
   * so crouching or standing up still moves you as it would.
   */
  _standOffNow() {
    const eyeHeight = this.options.eyeHeight;
    if (!Number.isFinite(eyeHeight)) return 0;
    // The camera's position in the rig is the headset's in the room.
    const head = THREE.MathUtils.clamp(this.camera?.position?.y || 0, 0, 2.5);
    return eyeHeight - head;
  }

  _sandHeightAt(x, z) {
    if (this.seabedOverride !== null) return this.seabedOverride;
    const models = (this.getModels?.() || []).filter(Boolean);
    const key = models.map((m) => m.uuid).join(',');
    if (!this.seabed || key !== this._modelKey) {
      this._modelKey = key;
      this.seabed = models.length ? fitSeabed(models) : null;
    }
    if (!this.seabed) return null;
    const { a, b, c, grid } = this.seabed;
    const plane = a * x + b * z + c;
    if (!grid) return plane;

    // Follow the scanned sand where there is some: the lowest point in each
    // grid square, blended between squares. A square whose lowest point is
    // well off the plane is wreck, a scour hole or a gap, so it counts as the
    // plane instead.
    const { lowest, N, minX, minZ, sx, sz } = grid;
    const fx = (x - minX) / sx - 0.5;
    const fz = (z - minZ) / sz - 0.5;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const band = this.options.sandBand;
    const at = (ix, iz) => {
      if (ix < 0 || iz < 0 || ix >= N || iz >= N) return plane;
      const y = lowest[iz * N + ix];
      return Math.abs(y - plane) > band ? plane : y;
    };
    return (at(x0, z0) * (1 - tx) + at(x0 + 1, z0) * tx) * (1 - tz) +
           (at(x0, z0 + 1) * (1 - tx) + at(x0 + 1, z0 + 1) * tx) * tz;
  }
}

/**
 * The plane y = a·x + b·z + c through the sand round the edge of the scan.
 * Grid the models from above, take the lowest point in each square on the
 * outline of the scanned area, fit a plane, then fit again without stray
 * points (a hanging plate, a scour hole).
 */
export function fitSeabed(models) {
  const box = new THREE.Box3();
  models.forEach((m) => {
    m.updateMatrixWorld(true);
    box.expandByObject(m);
  });
  if (box.isEmpty()) return null;

  const N = 48;
  const lowest = new Float32Array(N * N).fill(Infinity);
  const sx = (box.max.x - box.min.x) / N || 1;
  const sz = (box.max.z - box.min.z) / N || 1;
  const v = new THREE.Vector3();

  models.forEach((m) => m.traverse((o) => {
    const position = o.isMesh && o.geometry?.attributes?.position;
    if (!position) return;
    const step = Math.max(1, Math.floor(position.count / 200000));
    for (let i = 0; i < position.count; i += step) {
      v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
      const cx = Math.min(N - 1, Math.max(0, Math.floor((v.x - box.min.x) / sx)));
      const cz = Math.min(N - 1, Math.max(0, Math.floor((v.z - box.min.z) / sz)));
      const k = cz * N + cx;
      if (v.y < lowest[k]) lowest[k] = v.y;
    }
  }));

  const filled = (x, z) => x >= 0 && z >= 0 && x < N && z < N && lowest[z * N + x] !== Infinity;
  const edge = [];
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      if (!filled(x, z)) continue;
      if (!filled(x - 1, z) || !filled(x + 1, z) || !filled(x, z - 1) || !filled(x, z + 1)) {
        edge.push([box.min.x + (x + 0.5) * sx, box.min.z + (z + 0.5) * sz, lowest[z * N + x]]);
      }
    }
  }
  const grid = { lowest, N, minX: box.min.x, minZ: box.min.z, sx, sz };
  if (edge.length < 3) return { a: 0, b: 0, c: box.min.y, grid };

  let fit = fitPlane(edge);
  const residuals = edge.map(([x, z, y]) => y - (fit.a * x + fit.b * z + fit.c));
  const spread = Math.sqrt(residuals.reduce((t, r) => t + r * r, 0) / residuals.length);
  const kept = edge.filter((_, i) => Math.abs(residuals[i]) <= 2 * spread);
  if (kept.length >= 3) fit = fitPlane(kept);
  return { ...fit, grid };
}

// Least-squares y = a·x + b·z + c (Cramer's rule on the normal equations).
function fitPlane(points) {
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sxy = 0, szy = 0, sy = 0;
  const n = points.length;
  for (const [x, z, y] of points) {
    sxx += x * x; sxz += x * z; szz += z * z;
    sx += x; sz += z;
    sxy += x * y; szy += z * y; sy += y;
  }
  const det3 = (m) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [sxx, sxz, sx, sxz, szz, sz, sx, sz, n];
  const d = det3(M);
  if (Math.abs(d) < 1e-9) return { a: 0, b: 0, c: sy / n };
  const r = [sxy, szy, sy];
  const col = (i) => M.map((m, k) => (k % 3 === i ? r[Math.floor(k / 3)] : m));
  return { a: det3(col(0)) / d, b: det3(col(1)) / d, c: det3(col(2)) / d };
}
