/**
 * VRSurface - the sea surface and a dive boat, as a VR Easter egg
 *
 * With `vr.surfaceDepth` set (the seabed depth in metres), a VR viewer who
 * swims all the way up breaks the surface: open water to the horizon, sky,
 * and a dive boat riding on its shot line above the wreck. From below, the
 * surface is a bright rippled ceiling with Snell's window overhead, and the
 * boat's hull and the shot line can be seen as you get close.
 *
 * The surface sits `surfaceDepth` above the seabed plane fitted through the
 * sand round the edge of the scan (or `vr.seabedHeight` if given). The viewer
 * can't rise past eye level at the surface.
 *
 * Nothing here changes the scene outside a VR session. Above the surface the
 * sky and haze are swapped in for each frame only (beforeRender/afterRender),
 * so a page's own underwater fog and backdrop are left as they are.
 *
 * Everything is drawn without scene lights (the boat's shading is baked into
 * vertex colours), so crossing the surface never changes the lighting setup
 * and no shaders recompile mid-session.
 */

import * as THREE from 'three';
import { fitSeabed } from '../passthrough/VRPassthrough.js';

const DEFAULTS = {
  depth: null,          // seabed depth (m); null = off
  boat: true,           // show the dive boat
  line: true,           // shot line from the boat down to the wreck
  boatOffset: 14,       // boat this far (m) from the wreck's centre, along its length
  eyeAbove: 0.25,       // eyes at most this far above the surface (m)
  seabedHeight: null    // fixed seabed height instead of the fitted plane
};

const SKY_TOP = new THREE.Color('#2f7fc4');
const SKY_HORIZON = new THREE.Color('#cfe6f2');
const SEA_DEEP = new THREE.Color('#0d4a63');
const SUN_DIR = new THREE.Vector3(-0.45, 0.7, 0.55).normalize();

export class VRSurface {
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
    this.options = { ...DEFAULTS };
    for (const [k, v] of Object.entries(options)) if (v !== undefined && v !== null) this.options[k] = v;

    this.surfaceY = null;     // world height of the surface
    this.centre = null;       // wreck centre (x, z)
    this.above = false;       // head above the surface
    this.onChange = null;     // (above: boolean) => void

    this.group = new THREE.Group();
    this.group.name = 'belowjs-surface';
    this.group.visible = false;
    this.scene.add(this.group);

    this._time = 0;
    this._modelKey = null;
    this._built = false;
    this._saved = null;
    this._hidden = [];
    this._head = new THREE.Vector3();
  }

  setCamera(camera) { this.camera = camera; }

  /** Set the seabed depth (m) and turn the surface on; null turns it off. */
  setDepth(depth) {
    this.options.depth = Number.isFinite(depth) && depth > 0 ? depth : null;
    this.refresh();
  }

  /** Recompute the surface height, e.g. after the model was moved or levelled. */
  refresh() { this._modelKey = null; }

  get enabled() { return Number.isFinite(this.options.depth); }

  /** True while a VR viewer's head is above the surface. */
  isAboveSurface() { return this.above; }

  /** World height of the viewer's eyes (the XR camera inside the dolly). */
  headHeight() {
    const rig = this.camera.parent;
    const xrCam = this.renderer.xr?.getCamera?.();
    const local = xrCam && this.renderer.xr?.isPresenting ? xrCam.position : this.camera.position;
    this._head.copy(local);
    if (rig) { rig.updateMatrixWorld(true); this._head.applyMatrix4(rig.matrixWorld); }
    return this._head.y;
  }

  _vrSession() {
    const xr = this.renderer.xr;
    if (!xr?.isPresenting) return false;
    const session = xr.getSession?.();
    // Tabletop AR places the wreck on a real table: no sea there.
    return !(session?.mode === 'immersive-ar' && !session.belowjsPassthrough);
  }

  _locate() {
    const models = this.getModels().filter(Boolean);
    const key = models.map((m) => m.uuid).join(',');
    if (key === this._modelKey && this.surfaceY !== null) return true;
    if (!models.length) return false;
    const box = new THREE.Box3();
    models.forEach((m) => { m.updateMatrixWorld(true); box.expandByObject(m); });
    if (box.isEmpty()) return false;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    let seabed = this.options.seabedHeight;
    if (!Number.isFinite(seabed)) {
      const f = fitSeabed(models);
      seabed = f ? f.a * cx + f.b * cz + f.c : box.min.y;
    }
    this.surfaceY = seabed + this.options.depth;
    // The wreck's long axis, so the boat lies off one end of it.
    const size = box.getSize(new THREE.Vector3());
    this.centre = { x: cx, z: cz, alongX: size.x >= size.z, length: Math.max(size.x, size.z), modelTop: box.max.y };
    this._modelKey = key;
    this._place();
    return true;
  }

  _build() {
    if (this._built) return;
    this._built = true;
    const far = this.camera.far || 2000;
    this.water = makeWater(far * 1.6);
    this.sky = makeSky(far * 0.85);
    this.group.add(this.water, this.sky);
    if (this.options.boat) {
      this.boat = makeDiveBoat();
      this.group.add(this.boat);
    }
    if (this.options.line) {
      this.line = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true).translate(0, 0.5, 0),
        new THREE.MeshBasicMaterial({ color: '#d8c23a', fog: true })
      );
      this.line.name = 'belowjs-shot-line';
      this.group.add(this.line);
    }
  }

  _place() {
    if (!this._built || this.surfaceY === null) return;
    const { x, z, alongX, length } = this.centre;
    this.water.position.set(x, this.surfaceY, z);
    const off = Math.min(this.options.boatOffset, length * 0.35);
    if (this.boat) {
      this.boat.position.set(alongX ? x + off : x, this.surfaceY, alongX ? z : z + off);
      this.boat.rotation.y = alongX ? 0.35 : Math.PI / 2 + 0.35;
    }
    this._lineBottom = new THREE.Vector3(alongX ? x + off * 0.4 : x, this.centre.modelTop + 0.3, alongX ? z : z + off * 0.4);
  }

  /** Per frame, after locomotion. */
  update(deltaTime) {
    this._time += deltaTime || 0;
    const on = this.enabled && this._vrSession();
    if (!on) {
      this.group.visible = false;
      this._setAbove(false);
      return;
    }
    this._build();
    if (!this._locate()) return;
    this.group.visible = true;

    // Eyes no higher than just above the surface.
    const limit = this.surfaceY + this.options.eyeAbove;
    const head = this.headHeight();
    if (head > limit && this.camera.parent) {
      this.camera.parent.position.y -= head - limit;
      this.camera.parent.updateMatrixWorld(true);
    }
    this._setAbove(this.headHeight() > this.surfaceY + 0.02);

    // The boat rides the swell; the shot line follows its bow.
    const t = this._time;
    if (this.boat) {
      this.boat.position.y = this.surfaceY + 0.06 * Math.sin(t * 0.9);
      this.boat.rotation.x = 0.025 * Math.sin(t * 0.7 + 1.1);
      this.boat.rotation.z = 0.035 * Math.sin(t * 0.55);
      this.boat.updateMatrixWorld(true);
    }
    if (this.line && this._lineBottom) {
      const top = this.boat ? this.boat.localToWorld(new THREE.Vector3(5.2, 0.1, 0)) : this.water.position.clone();
      const d = top.clone().sub(this._lineBottom);
      this.line.position.copy(this._lineBottom);
      this.line.scale.set(1, d.length(), 1);
      this.line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    }
    this.water.material.uniforms.uTime.value = t;
    this.water.material.uniforms.uSurfaceY.value = this.surfaceY;
    const fog = this.scene.fog;
    if (fog?.color) this.water.material.uniforms.uWater.value.copy(fog.color);
    if (fog && Number.isFinite(fog.density)) this.water.material.uniforms.uDensity.value = fog.density;
  }

  _setAbove(above) {
    if (above === this.above) return;
    this.above = above;
    this.onChange?.(above);
  }

  /** Just before the render: sky and haze in place of the underwater look. */
  beforeRender() {
    if (!this.group.visible) return;
    const camPos = this.water.material.uniforms.uCamera.value;
    this.headHeight();
    camPos.copy(this._head);
    this.sky.visible = this.above;
    if (!this.above) return;
    // Thin the page's own fog to a light sea haze rather than swapping the fog
    // object, which would make every material re-select its shader each frame.
    const fog = this.scene.fog;
    this._saved = { background: this.scene.background, fog: fog && { color: fog.color?.clone(), density: fog.density, near: fog.near, far: fog.far } };
    if (fog?.isFogExp2) { fog.color.copy(SKY_HORIZON); fog.density = 0.0012; }
    else if (fog?.isFog) { fog.color.copy(SKY_HORIZON); fog.near = 120; fog.far = 1400; }
    this.scene.background = SKY_HORIZON;
    this.sky.position.copy(camPos);
    // Marine snow and other particles belong underwater.
    this._hidden.length = 0;
    this.scene.traverse((o) => {
      if (o.isPoints && o.visible) { o.visible = false; this._hidden.push(o); }
    });
  }

  afterRender() {
    if (!this._saved) return;
    const fog = this.scene.fog, f = this._saved.fog;
    if (fog && f) {
      if (f.color) fog.color.copy(f.color);
      if (fog.isFogExp2) fog.density = f.density;
      else if (fog.isFog) { fog.near = f.near; fog.far = f.far; }
    }
    this.scene.background = this._saved.background;
    this._saved = null;
    for (const o of this._hidden) o.visible = true;
    this._hidden.length = 0;
  }

  sessionEnded() {
    this.group.visible = false;
    this._setAbove(false);
  }

  dispose() {
    this.afterRender();
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => x?.dispose?.());
    });
  }
}

// ── The sea surface ─────────────────────────────────────────────────────
// One plane, shaded differently from each side. From below: a bright ceiling
// with Snell's window overhead and rippling caustic light, fading into the
// water with distance. From above: deep water, sky reflected towards the
// horizon, and sun glints off the ripples.
function makeWater(size) {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uCamera: { value: new THREE.Vector3() },
      uSurfaceY: { value: 0 },
      uWater: { value: new THREE.Color('#0d4560') },
      uDensity: { value: 0.035 },
      uSkyTop: { value: SKY_TOP.clone() },
      uSkyHorizon: { value: SKY_HORIZON.clone() },
      uDeep: { value: SEA_DEEP.clone() },
      uSun: { value: SUN_DIR.clone() }
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime, uSurfaceY, uDensity;
      uniform vec3 uCamera, uWater, uSkyTop, uSkyHorizon, uDeep, uSun;
      varying vec3 vWorld;
      vec2 ripple(vec2 p, float t) {
        vec2 g = vec2(0.0);
        g += vec2(cos(p.x * 0.9 + t * 1.3), cos(p.y * 0.7 - t * 1.1)) * 0.35;
        g += vec2(cos((p.x + p.y) * 1.7 + t * 1.9), cos((p.x - p.y) * 1.5 - t * 1.6)) * 0.2;
        g += vec2(cos(p.y * 3.1 + t * 2.7), cos(p.x * 2.9 + t * 2.3)) * 0.08;
        return g;
      }
      void main() {
        vec3 toFrag = vWorld - uCamera;
        float dist = length(toFrag);
        vec3 v = toFrag / max(dist, 1e-4);
        vec2 g = ripple(vWorld.xz, uTime);
        vec3 n = normalize(vec3(-g.x * 0.12, 1.0, -g.y * 0.12));
        vec3 col;
        if (uCamera.y < uSurfaceY) {
          // Underneath: Snell's window straight up, total internal reflection outside it.
          float up = clamp(v.y, 0.0, 1.0);
          float window = smoothstep(0.62, 0.70, up);
          float caustic = 0.5 + 0.5 * sin(dot(g, vec2(4.0, 3.0)) + uTime * 0.6);
          vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.7, 1.0, up)) * (0.9 + 0.25 * caustic);
          vec3 mirror = mix(uWater, uSkyHorizon, 0.18) * (0.75 + 0.35 * caustic);
          col = mix(mirror, sky, window);
          // The water in between: same fog as the scene.
          float f = exp(-uDensity * uDensity * dist * dist);
          col = mix(uWater, col, f);
        } else {
          // From above: reflect the sky, more so towards the horizon.
          vec3 r = reflect(v, n);
          float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(-v, n), 0.0), 5.0);
          vec3 sky = mix(uSkyHorizon, uSkyTop, clamp(r.y, 0.0, 1.0));
          col = mix(uDeep, sky, fresnel);
          col += vec3(1.0, 0.96, 0.85) * pow(max(dot(r, uSun), 0.0), 220.0) * 1.6;
          col = mix(col, uSkyHorizon, smoothstep(250.0, 1200.0, dist));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), material);
  mesh.name = 'belowjs-sea-surface';
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  return mesh;
}

function makeSky(radius) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTop: { value: SKY_TOP.clone() }, uHorizon: { value: SKY_HORIZON.clone() }, uSun: { value: SUN_DIR.clone() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 uTop, uHorizon, uSun; varying vec3 vDir;
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 c = mix(uHorizon, uTop, pow(h, 0.55));
          float s = max(dot(normalize(vDir), uSun), 0.0);
          c += vec3(1.0, 0.95, 0.8) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.15);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`
    })
  );
  mesh.name = 'belowjs-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.visible = false;
  mesh.raycast = () => {};
  return mesh;
}

// ── A generic dive boat ────────────────────────────────────────────────
// About 11 m: a white planing hull with a blue boot stripe and red
// antifouling, a wheelhouse with a hard top, dive ladder and swim platform
// at the stern, cylinders racked down both sides, and the dive flags.
// Shading is baked into vertex colours from a fixed sun direction.
export function makeDiveBoat() {
  const parts = [];
  const add = (geo, colour, { lit = true } = {}) => {
    geo = geo.index ? geo.toNonIndexed() : geo;
    geo.computeVertexNormals();
    const n = geo.attributes.normal, c = new THREE.Color(colour), out = new Float32Array(n.count * 3);
    for (let i = 0; i < n.count; i++) {
      const lambert = lit ? 0.45 + 0.55 * Math.max(0, n.getX(i) * SUN_DIR.x + n.getY(i) * SUN_DIR.y + n.getZ(i) * SUN_DIR.z) + 0.1 * Math.max(0, n.getY(i)) : 1;
      out[i * 3] = c.r * lambert; out[i * 3 + 1] = c.g * lambert; out[i * 3 + 2] = c.b * lambert;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'color'].includes(name)) geo.deleteAttribute(name);
    parts.push(geo);
  };
  const box = (sx, sy, sz, x, y, z, colour) => add(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z), colour);
  const bar = (a, b, r, colour, seg = 6) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
    const g = new THREE.CylinderGeometry(r, r, d.length(), seg);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    add(g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2), colour);
  };

  // Hull: stations along x (stern -5.5 to bow +5.5), a deep-V section that
  // flares to the sheer; the waterline is y = 0.
  const L0 = -5.5, L1 = 5.5, ST = 24, RW = 10;
  const sheer = (x) => 1.05 + 0.35 * Math.max(0, (x - 1) / (L1 - 1)) ** 2;
  const keel = (x) => -0.75 + 0.75 * Math.max(0, (x - 2.5) / (L1 - 2.5)) ** 1.6;
  const half = (x) => 1.75 * (x < 2 ? 1 : Math.sqrt(Math.max(0.0001, 1 - ((x - 2) / (L1 - 2)) ** 2)));
  const point = (x, j, side) => {
    const t = j / RW;                                  // 0 keel .. 1 sheer
    const y = keel(x) + (sheer(x) - keel(x)) * t;
    const w = half(x) * Math.min(1, 0.15 + 1.25 * t) * (0.92 + 0.08 * t);
    return [x, y, side * w];
  };
  const hullBand = (j0, j1, colour) => {
    const pos = [];
    for (let i = 0; i < ST; i++) {
      const xa = L0 + (L1 - L0) * (i / ST), xb = L0 + (L1 - L0) * ((i + 1) / ST);
      for (const side of [-1, 1]) {
        for (let j = j0; j < j1; j++) {
          const a = point(xa, j, side), b = point(xb, j, side), c = point(xb, j + 1, side), d = point(xa, j + 1, side);
          if (side > 0) pos.push(...a, ...b, ...c, ...a, ...c, ...d); else pos.push(...a, ...c, ...b, ...a, ...d, ...c);
        }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); add(g, colour);
  };
  hullBand(0, 6, '#9b2a22');      // antifouling, below the waterline
  hullBand(6, 7, '#1f4f8f');      // boot stripe
  hullBand(7, RW, '#f2f2ee');     // topsides
  // Transom, deck and a rubbing strake.
  {
    const pos = [];
    for (let j = 0; j < RW; j++) {
      const a = point(L0, j, -1), b = point(L0, j, 1), c = point(L0, j + 1, 1), d = point(L0, j + 1, -1);
      pos.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); add(g, '#eeeeea');
    const deck = [];
    for (let i = 0; i < ST; i++) {
      const xa = L0 + (L1 - L0) * (i / ST), xb = L0 + (L1 - L0) * ((i + 1) / ST);
      const pa = point(xa, RW, 1), pb = point(xb, RW, 1), ya = sheer(xa) - 0.25, yb = sheer(xb) - 0.25;
      deck.push(xa, ya, -pa[2], xb, yb, pb[2], xb, yb, -pb[2], xa, ya, -pa[2], xa, ya, pa[2], xb, yb, pb[2]);
    }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3)); add(dg, '#d9d6cc');
    for (const side of [-1, 1]) {
      for (let i = 0; i < ST; i++) {
        const xa = L0 + (L1 - L0) * (i / ST), xb = L0 + (L1 - L0) * ((i + 1) / ST);
        const a = point(xa, RW, side), b = point(xb, RW, side);
        bar([a[0], a[1] - 0.05, a[2] + side * 0.04], [b[0], b[1] - 0.05, b[2] + side * 0.04], 0.05, '#2a2a2a', 5);
        // Guard rail on stanchions.
        bar([a[0], a[1] + 0.75, a[2]], [b[0], b[1] + 0.75, b[2]], 0.02, '#c8ccd0', 5);
        if (i % 3 === 0) bar([a[0], a[1], a[2]], [a[0], a[1] + 0.75, a[2]], 0.018, '#c8ccd0', 5);
      }
    }
  }
  // Wheelhouse: white with dark windows, and a hard top over the back deck.
  box(3.0, 1.9, 2.4, 1.2, 1.9, 0, '#f4f4f0');
  box(0.05, 0.75, 2.1, 2.73, 2.35, 0, '#1a2a33');
  for (const s of [-1, 1]) box(2.4, 0.7, 0.05, 1.2, 2.35, s * 1.23, '#1a2a33');
  box(5.6, 0.12, 2.9, -0.3, 2.95, 0, '#f4f4f0');
  for (const s of [-1, 1]) for (const x of [-2.9, -1.3]) bar([x, 1.0, s * 1.35], [x, 2.9, s * 1.35], 0.04, '#c8ccd0');
  // Radar dome, mast with the dive flags.
  add(new THREE.SphereGeometry(0.32, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(1.6, 3.01, 0), '#f6f6f6');
  bar([0.6, 3.0, 0], [0.6, 5.0, 0], 0.035, '#c8ccd0');
  // Code flag A (diver down, keep clear): white at the hoist, blue swallowtail.
  {
    const w = 0.6, h = 0.42, y = 4.75, x = 0.62;
    add(new THREE.PlaneGeometry(w / 2, h).translate(x + w / 4, y, 0), '#ffffff', { lit: false });
    const s = new THREE.Shape(); s.moveTo(0, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2 - 0.12, 0); s.lineTo(w / 2, h / 2); s.lineTo(0, h / 2);
    add(new THREE.ShapeGeometry(s).translate(x + w / 2, y, 0.001), '#1f4fb3', { lit: false });
  }
  // Diver-down flag (red with a white diagonal) lower on the mast.
  {
    const x = 0.62, y = 4.2, w = 0.5, h = 0.36;
    add(new THREE.PlaneGeometry(w, h).translate(x + w / 2, y, 0), '#d41f1f', { lit: false });
    const d = new THREE.PlaneGeometry(Math.hypot(w, h), 0.08).rotateZ(-Math.atan2(h, w)).translate(x + w / 2, y, 0.002);
    add(d, '#ffffff', { lit: false });
  }
  // Cylinders racked along both sides of the back deck, valves up.
  for (const s of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const x = -4.6 + k * 0.42, z = s * 1.35, base = sheer(x) - 0.25;
      add(new THREE.CylinderGeometry(0.1, 0.1, 0.62, 10).translate(x, base + 0.31, z), k % 3 === 2 ? '#e5c315' : '#a9b0b5');
      bar([x, base + 0.62, z], [x, base + 0.72, z], 0.03, '#2a2a2a');
    }
    bar([-4.8, sheer(-4.8) + 0.25, s * 1.47], [-2.3, sheer(-2.3) + 0.25, s * 1.47], 0.025, '#3a3a3a');
  }
  // Swim platform and dive ladder off the transom, rungs going into the water.
  box(0.8, 0.08, 2.8, L0 - 0.4, 0.25, 0, '#d9d6cc');
  for (const s of [-0.28, 0.28]) bar([L0 - 0.7, 0.3, s], [L0 - 0.85, -1.3, s], 0.025, '#c8ccd0');
  for (let r = 0; r < 5; r++) {
    const t = r / 4, x = L0 - 0.7 - 0.15 * t, y = 0.2 - 1.45 * t;
    bar([x, y, -0.28], [x, y, 0.28], 0.018, '#c8ccd0');
  }
  // Outboard-style leg under the stern and a bow cleat for the shot line.
  box(0.25, 0.9, 0.12, L0 + 0.3, -0.75, 0, '#2a2a2a');
  box(0.3, 0.08, 0.1, 5.1, sheer(5.1) - 0.18, 0, '#c8ccd0');

  const merged = mergeParts(parts);
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, side: THREE.DoubleSide }));
  mesh.name = 'belowjs-dive-boat';
  mesh.raycast = () => {};
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

function mergeParts(parts) {
  let count = 0;
  for (const g of parts) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}
