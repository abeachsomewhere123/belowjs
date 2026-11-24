// VR sea surface and dive boat. Run with: node --test tests/vr-surface.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VRSurface, makeDiveBoat } from '../src/vr/surface/VRSurface.js';

// A flat 40 x 30 m sand patch at y = -5 with a 4 m tall "wreck" on it.
function makeScene({ presenting = true, mode = 'immersive-vr' } = {}) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0d4560, 0.035);
  scene.background = new THREE.Color(0x062536);
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(40, 30, 80, 60).rotateX(-Math.PI / 2));
  sand.position.y = -5;
  const wreck = new THREE.Mesh(new THREE.BoxGeometry(24, 4, 7));
  wreck.position.set(0, -3, 0);
  const model = new THREE.Group(); model.add(sand, wreck); scene.add(model);
  const snow = new THREE.Points(new THREE.BufferGeometry()); scene.add(snow);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const dolly = new THREE.Group(); dolly.add(camera); scene.add(dolly);
  const xrCamera = new THREE.PerspectiveCamera(); xrCamera.position.set(0, 1.6, 0);
  const renderer = { xr: { isPresenting: presenting, getSession: () => ({ mode }), getCamera: () => xrCamera } };
  return { scene, model, camera, dolly, renderer, snow };
}

test('off until a depth is given', () => {
  const { scene, model, camera, renderer } = makeScene();
  const s = new VRSurface(renderer, scene, camera, () => [model]);
  s.update(0.016);
  assert.equal(s.group.visible, false);
  assert.equal(s.surfaceY, null);
});

test('surface sits the seabed depth above the sand', () => {
  const { scene, model, camera, renderer } = makeScene();
  const s = new VRSurface(renderer, scene, camera, () => [model], { depth: 45 });
  s.update(0.016);
  assert.equal(s.group.visible, true);
  assert.ok(Math.abs(s.surfaceY - 40) < 0.05, `surfaceY=${s.surfaceY}`);   // sand at -5, 45 m deep
});

test('cannot rise past eye level at the surface, and reports breaking it', () => {
  const { scene, model, camera, dolly, renderer } = makeScene();
  const s = new VRSurface(renderer, scene, camera, () => [model], { depth: 45 });
  const changes = [];
  s.onChange = (v) => changes.push(v);
  dolly.position.y = 10; s.update(0.016);
  assert.equal(s.isAboveSurface(), false);
  dolly.position.y = 60; s.update(0.016);            // flew far too high
  assert.ok(Math.abs(s.headHeight() - (40 + 0.25)) < 1e-6, `head=${s.headHeight()}`);
  assert.equal(s.isAboveSurface(), true);
  dolly.position.y = 30; s.update(0.016);            // back down
  assert.equal(s.isAboveSurface(), false);
  assert.deepEqual(changes, [true, false]);
});

test('above the surface: sky and haze for the frame only, then the page look comes back', () => {
  const { scene, model, camera, dolly, renderer, snow } = makeScene();
  const fog = scene.fog, background = scene.background;
  const s = new VRSurface(renderer, scene, camera, () => [model], { depth: 45 });
  dolly.position.y = 60; s.update(0.016);
  s.beforeRender();
  assert.equal(scene.fog, fog, 'same fog object, so materials keep their shaders');
  assert.ok(fog.density < 0.01);
  assert.notEqual(scene.background, background);
  assert.equal(snow.visible, false);
  s.afterRender();
  assert.equal(scene.fog.density, 0.035);
  assert.equal(scene.fog.color.getHex(), 0x0d4560);
  assert.equal(scene.background, background);
  assert.equal(snow.visible, true);
});

test('nothing in tabletop AR or outside VR', () => {
  for (const opts of [{ presenting: false }, { mode: 'immersive-ar' }]) {
    const { scene, model, camera, renderer } = makeScene(opts);
    const s = new VRSurface(renderer, scene, camera, () => [model], { depth: 45 });
    s.update(0.016);
    assert.equal(s.group.visible, false);
  }
});

test('the boat is about 11 m long, floats with its keel below the waterline', () => {
  const boat = makeDiveBoat();
  const box = new THREE.Box3().setFromObject(boat);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.x > 10 && size.x < 13, `length ${size.x}`);
  assert.ok(size.z > 3 && size.z < 4.2, `beam ${size.z}`);
  assert.ok(box.min.y < -0.5 && box.max.y > 4, `y ${box.min.y}..${box.max.y}`);
});
