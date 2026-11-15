// VR passthrough-on-seabed logic. Run with: node --test tests/vr-passthrough.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VRPassthrough, fitSeabed } from '../src/vr/passthrough/VRPassthrough.js';

// A tilted 40 x 30 m sand patch (y = 0.05x - 5) with a 6 m tall "wreck" block on it.
function makeScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x1d5b77, 0.02);
  scene.background = new THREE.Color(0x0c3a55);
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(40, 30, 160, 120).rotateX(-Math.PI / 2));
  const p = sand.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, 0.05 * p.getX(i) - 5);
  const wreck = new THREE.Mesh(new THREE.BoxGeometry(20, 6, 8));
  wreck.position.set(0, -2, 0);
  const model = new THREE.Group(); model.add(sand, wreck); scene.add(model);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 120);
  const dolly = new THREE.Group(); dolly.add(camera); scene.add(dolly);
  camera.position.set(0, 1.6, 0);
  const renderer = { xr: { getCamera: () => camera } };
  return { scene, model, camera, dolly, renderer };
}

test('seabed plane is fitted through the sand, not the wreck', () => {
  const { model } = makeScene();
  const f = fitSeabed([model]);
  assert.ok(Math.abs(f.a - 0.05) < 0.01, `a=${f.a}`);
  assert.ok(Math.abs(f.b) < 0.01, `b=${f.b}`);
  assert.ok(Math.abs(f.c + 5) < 0.05, `c=${f.c}`);
});

test('lands on the sand, walks on it, lifts off, and fades', () => {
  const { scene, model, camera, dolly, renderer } = makeScene();
  const pt = new VRPassthrough(renderer, scene, camera, () => [model]);
  const changes = [];
  pt.onChange = (v) => changes.push(v);
  pt.sessionStarted({ belowjsPassthrough: true, environmentBlendMode: 'alpha-blend' });
  assert.equal(pt.active, true);

  dolly.position.set(10, 3, 12);          // swimming 7.5 m above sand at x=10 (sand -4.5)
  pt.update(1 / 72);
  assert.equal(pt.landed, false);

  dolly.position.y = -4.45;               // drift down to within 5 cm of the sand
  pt.update(1 / 72);
  assert.equal(pt.landed, true);
  const sandAt = (x, z) => pt._sandHeightAt(x, z);
  assert.ok(Math.abs(dolly.position.y - sandAt(10, 12)) < 1e-9, 'snapped to the sand');
  assert.ok(Math.abs(dolly.position.y + 4.5) < 0.05, 'and the sand is where it should be');
  assert.deepEqual(changes, [true]);

  for (let i = 0; i < 72; i++) pt.update(1 / 72);   // one second: fully faded
  assert.equal(pt.blend, 1);

  // Walk 20 m downhill in small steps without touching the vertical control.
  for (let x = 10; x >= -10; x -= 0.05) { dolly.position.x = x; pt.update(1 / 72); }
  dolly.position.x = -10; pt.update(1 / 72);
  dolly.position.y -= 0.3; pt.update(1 / 72);  // pushing down keeps you on the sand
  assert.ok(Math.abs(dolly.position.y - sandAt(-10, 12)) < 1e-9, 'follows the sand downhill');
  assert.ok(Math.abs(dolly.position.y + 5.5) < 0.05);
  assert.equal(pt.landed, true);

  for (let x = -10; x <= 10; x += 0.05) { dolly.position.x = x; pt.update(1 / 72); }
  assert.equal(pt.landed, true, 'walking uphill stays on the sand');

  // Over the wreck the floor stays at the sand, not the deck.
  dolly.position.x = 0; pt.update(1 / 72);
  assert.ok(Math.abs(dolly.position.y - sandAt(0, 12)) < 1e-9);
  assert.ok(Math.abs(dolly.position.y + 5) < 0.05);

  // Small rises are walked off; a real climb lifts off.
  for (let i = 0; i < 3; i++) { dolly.position.y += 0.1; pt.update(1 / 72); }
  assert.equal(pt.landed, true);
  for (let i = 0; i < 3; i++) { dolly.position.y += 0.1; pt.update(1 / 72); }
  assert.equal(pt.landed, false);
  assert.deepEqual(changes, [true, false]);
  for (let i = 0; i < 72; i++) pt.update(1 / 72);
  assert.equal(pt.blend, 0);
});

test('backdrop hides the room in VR; fog thins with the fade and is put back', () => {
  const { scene, model, camera, dolly, renderer } = makeScene();
  const pt = new VRPassthrough(renderer, scene, camera, () => [model]);
  pt.sessionStarted({ belowjsPassthrough: true, environmentBlendMode: 'alpha-blend' });
  pt.beforeRender();
  assert.equal(pt.backdrop.visible, true);
  assert.equal(pt.backdrop.material.opacity, 1);
  assert.equal(pt.backdrop.material.color.getHex(), 0x0c3a55);
  assert.ok(pt.backdrop.scale.x * 500 < camera.far, 'inside the far plane');
  pt.afterRender();

  dolly.position.set(0, -5, 0); pt.update(1 / 72);
  pt.blend = 0.5;
  pt.beforeRender();
  assert.ok(Math.abs(scene.fog.density - 0.01) < 1e-9);
  assert.equal(pt.backdrop.material.opacity, 0.5);
  pt.afterRender();
  assert.equal(scene.fog.density, 0.02, 'fog restored after the frame');

  pt.blend = 1; pt.beforeRender();
  assert.equal(pt.backdrop.visible, false);
  pt.afterRender();
});

test('a texture background is taken away for the frame and put back', () => {
  // three draws a texture background as an opaque box even in alpha-blend
  // sessions, which would cover the room.
  const { scene, model, camera, renderer } = makeScene();
  const water = new THREE.Texture();
  scene.background = water;
  const pt = new VRPassthrough(renderer, scene, camera, () => [model]);
  pt.sessionStarted({ belowjsPassthrough: true, environmentBlendMode: 'alpha-blend' });
  pt.beforeRender();
  assert.equal(scene.background, null, 'no background while rendering');
  assert.equal(pt.backdrop.material.map, water, 'the backdrop shows the water instead');
  pt.afterRender();
  assert.equal(scene.background, water, 'background restored after the frame');

  pt.sessionEnded();
  pt.beforeRender(); pt.afterRender();
  assert.equal(scene.background, water, 'left alone outside passthrough sessions');
});

test('ordinary VR and polyfilled sessions never show the room', () => {
  const { scene, model, camera, dolly, renderer } = makeScene();
  const pt = new VRPassthrough(renderer, scene, camera, () => [model]);
  pt.sessionStarted({ environmentBlendMode: 'opaque' });
  dolly.position.set(0, -5, 0); pt.update(1 / 72);
  assert.equal(pt.active, false); assert.equal(pt.landed, false);
  pt.sessionStarted({ belowjsPassthrough: true, environmentBlendMode: 'opaque' });
  assert.equal(pt.active, false);
});

test('a fixed seabed height overrides the estimate', () => {
  const { scene, model, camera, dolly, renderer } = makeScene();
  const pt = new VRPassthrough(renderer, scene, camera, () => [model], { seabedHeight: -2 });
  pt.sessionStarted({ belowjsPassthrough: true, environmentBlendMode: 'alpha-blend' });
  dolly.position.set(0, -1.9, 0); pt.update(1 / 72);
  assert.equal(pt.landed, true); assert.equal(dolly.position.y, -2);
});

test('follows a bump in the scanned sand, but not the wreck deck', () => {
  const { scene, model, camera, dolly, renderer } = makeScene();
  // A 40 cm sand ridge across x = 15.
  const sand = model.children[0]; const p = sand.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - 15) < 1.1) p.setY(i, p.getY(i) + 0.4);
  const pt = new VRPassthrough(renderer, scene, camera, () => [model]);
  pt.sessionStarted({ belowjsPassthrough: true, environmentBlendMode: 'alpha-blend' });
  dolly.position.set(13, -4.3, 10); pt.update(1 / 72);
  assert.equal(pt.landed, true);
  const flat = dolly.position.y;
  for (let x = 13; x <= 15.01; x += 0.05) { dolly.position.x = x; pt.update(1 / 72); }
  assert.ok(dolly.position.y - (flat + 0.1) > 0.15, `climbed the ridge: ${dolly.position.y - flat}`);
  assert.equal(pt.landed, true, 'the ridge is sand, not a lift-off');
  dolly.position.set(0, -5, 0); pt.update(1 / 72);
  assert.ok(Math.abs(dolly.position.y + 5) < 0.3, `under the 6 m wreck the floor stays near the sand: ${dolly.position.y}`);
});
