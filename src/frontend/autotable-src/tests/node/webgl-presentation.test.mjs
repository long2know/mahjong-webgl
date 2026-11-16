import test from 'node:test';
import assert from 'node:assert/strict';
import { gameHarness, thing, plain, require } from './renderer-test-support.mjs';
const { Matrix4, Vector3 } = require('three');

function fixture(t, handLayout = 'in-table') {
  const h = gameHarness(); t.after(h.close); h.join();
  h.adapter.setPresentation({
    viewMode: 'flat', boardLayout: 'rectangular', handLayout, tileLabels: true, lookDown: 0, zoom: 0,
  });
  const { buildWebglPlan, tileModel, fittedCamera } = h.load('renderer/webgl-layout.ts');
  const { WebglPresentation } = h.load('renderer/webgl-presentation.ts');
  const { rendererViewport } = h.load('renderer/renderer-viewport.ts');
  const motion = new WebglPresentation();
  const viewport = (width = 844, height = 390, revision = 1) => rendererViewport(h.adapter.instanceId, revision, {
    width, height, dpr: 2, separateHand: handLayout === 'separate', insets: { top: 60, left: 0, right: 0, bottom: 0 },
  });
  const target = (frame = h.adapter.latest, view = viewport()) => buildWebglPlan(h.adapter.layout, frame, view);
  const draw = (time, frame = h.adapter.latest, view = viewport()) => {
    const plan = target(frame, view), cue = motion.apply(plan, frame, view, time);
    return { plan, cue };
  };
  return { h, motion, target, draw, viewport, tileModel, fittedCamera };
}
const at = (plan, id) => plan.entities.get(id).pose;
const equalPose = (a, b) => assert.deepEqual(plain(a), plain(b));

test('real FULL updates move a stable entitled tile in FINAL rectangular layout space, without restarting on identical FULLs', t => {
  const f = fixture(t);
  let frame = f.h.snapshot([['4', thing('hand.0@0', 1)]]);
  const id = frame.entities[0].entityId, before = f.draw(0).plan;
  frame = f.h.snapshot([['4', thing('discard.0.0@0', 1)]], { activeSeat: 1, phase: 'AwaitingClaim' });
  assert.equal(frame.entities[0].entityId, id, 'routine FULL snapshots are not reconnects');
  const destination = at(f.target(), id), start = f.draw(100);
  equalPose(at(start.plan, id), at(before, id));
  assert.equal(start.cue.kind, 'discard');
  assert(at(start.plan, id).position.distanceTo(destination.position) > .05);
  const halfway = f.draw(220);
  assert(at(halfway.plan, id).position.distanceTo(destination.position) > 0);
  assert(at(halfway.plan, id).position.distanceTo(destination.position)
    < at(before, id).position.distanceTo(destination.position));
  const slot = halfway.plan.slots.get(frame.entities[0].slotName).poses[0];
  assert(slot.position.distanceTo(destination.position) < 1e-8, 'legal drop geometry remains the authoritative destination');
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]], { activeSeat: 1, phase: 'AwaitingClaim' });
  f.draw(250);
  equalPose(at(f.draw(340).plan, id), destination);
  assert(f.draw(749).cue);
  assert.equal(f.draw(751).cue, null, 'identical FULLs cannot extend the latest-action hold');
  assert.equal(f.motion.latestDiscardId, id, 'the latest discard remains statically marked after its brief accent');
});

test('a newly public reveal travels from a public seat anchor and never links to the concealed identity/pose', t => {
  const f = fixture(t);
  const hidden = f.h.snapshot([['h_concealed', thing('hand.0@1', null, 2)]]);
  const hiddenId = hidden.entities[0].entityId;
  const before = f.draw(0).plan;
  f.h.snapshot([['72', thing('discard.0.0@1', 18)]], { activeSeat: 2 });
  const id = f.h.adapter.latest.entities[0].entityId, destination = at(f.target(), id);
  const start = f.draw(100);
  assert.notEqual(id, hiddenId);
  assert.equal(start.plan.entities.has(hiddenId), false);
  assert.equal(f.motion.motions.has(hiddenId), false);
  assert(at(start.plan, id).position.distanceTo(at(before, hiddenId).position) > .01);
  assert(at(start.plan, id).position.distanceTo(destination.position) > .05);
  assert.equal(start.cue.seat, 1);
  assert(at(f.draw(220).plan, id).position.distanceTo(destination.position) > 0);
  equalPose(at(f.draw(340).plan, id), destination);
});

test('bursts retarget the last displayed pose, retain one tween per current visible entity and finish at the newest target', t => {
  const f = fixture(t);
  const first = f.h.snapshot([['4', thing('discard.0.0@0', 1)]]);
  const id = first.entities[0].entityId;
  f.draw(0);
  f.h.snapshot([['4', thing('discard.0.1@0', 1)]]);
  f.draw(100);
  let displayed = at(f.draw(180).plan, id);
  for (let index = 0; index < 30; index++) {
    f.h.snapshot([['4', thing(`discard.${index % 3}.${index % 6}@0`, 1)]]);
    const next = f.draw(181 + index);
    equalPose(at(next.plan, id), displayed);
    assert.equal(f.motion.motions.size, 1);
    displayed = at(f.draw(181.5 + index).plan, id);
  }
  equalPose(at(f.draw(451).plan, id), at(f.target(), id));
  assert.equal(f.draw(861).cue, null);
});

test('reconnects, authority changes, initial binding, resize, camera-space changes and explicit resume reset SNAP', t => {
  const f = fixture(t);
  const rows = [['4', thing('hand.0@0', 1)]];
  f.h.snapshot(rows); f.draw(0);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]]);
  f.draw(100);
  const resized = f.viewport(780, 360, 2), resizedDraw = f.draw(120, f.h.adapter.latest, resized);
  equalPose(at(resizedDraw.plan, f.h.adapter.latest.entities[0].entityId), at(f.target(f.h.adapter.latest, resized), f.h.adapter.latest.entities[0].entityId));
  assert.equal(resizedDraw.cue, null);
  f.h.adapter.setPresentation({ ...f.h.adapter.latest.presentation, handLayout: 'separate' });
  f.h.snapshot(rows);
  let id = f.h.adapter.latest.entities[0].entityId;
  equalPose(at(f.draw(130).plan, id), at(f.target(), id));
  assert.equal(f.draw(140).cue, null);
  f.motion.clear();
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]]);
  equalPose(at(f.draw(150).plan, id), at(f.target(), id));
  assert.equal(f.draw(151).cue, null);
  f.h.delta([], { rev: 2 });
  assert.equal(f.h.adapter.latest.entities.length, 0);
  f.draw(160);
  f.h.snapshot(rows, { rev: 2 });
  id = f.h.adapter.latest.entities[0].entityId;
  equalPose(at(f.draw(170).plan, id), at(f.target(), id));
  f.h.client.disconnect();
  f.h.join('new-room', 0);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]]);
  id = f.h.adapter.latest.entities[0].entityId;
  equalPose(at(f.draw(180).plan, id), at(f.target(), id));
  assert.equal(f.draw(181).cue, null);
});

test('the actual theme preference gives reduced motion instant placement and static cues; full explicitly overrides the OS', t => {
  const f = fixture(t);
  f.h.context.document.body = { classList: { toggle() {} } };
  f.h.context.window.matchMedia = () => ({ matches: true });
  const theme = f.h.load('theme.ts');
  theme.setMotionPreference('auto');
  const initial = f.h.snapshot([['4', thing('hand.0@0', 1)]]);
  const id = initial.entities[0].entityId; f.draw(0);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]]);
  const instant = f.draw(100);
  equalPose(at(instant.plan, id), at(f.target(), id));
  assert.equal(instant.cue.kind, 'discard');
  assert.equal(f.motion.motions.get(id).moving, false);
  theme.setMotionPreference('full'); f.draw(110);
  f.h.snapshot([['4', thing('discard.0.1@0', 1)]]);
  assert(at(f.draw(120).plan, id).position.distanceTo(at(f.target(), id).position) > 0);
  theme.setMotionPreference('reduced');
  equalPose(at(f.draw(130).plan, id), at(f.target(), id));
  assert(f.draw(140).cue, 'disabling travel must not remove action feedback');
});

test('separate-hand discard and public claim arrivals never interpolate between incompatible table/hand camera coordinates', t => {
  const f = fixture(t, 'separate');
  const first = f.h.snapshot([['4', thing('hand.0@0', 1)]]);
  const id = first.entities[0].entityId;
  const hand = f.draw(0).plan;
  assert.equal(hand.entities.get(id).separate, true);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]], { activeSeat: 1 });
  let target = at(f.target(), id), start = f.draw(100);
  assert.equal(start.plan.entities.get(id).separate, false);
  assert.equal(at(start.plan, id).position.x, target.position.x);
  assert.equal(at(start.plan, id).position.z, target.position.z);
  assert(at(start.plan, id).position.y > target.position.y);
  assert(at(start.plan, id).scale < target.scale, 'arrival remains visible even through an orthographic/flat camera');
  assert.equal(start.cue.sourceSeat, 0);
  equalPose(at(f.draw(340).plan, id), target);
  f.h.snapshot([['4', thing('meld.0.0@0', 1)]]);
  target = at(f.target(), id); start = f.draw(400);
  assert.equal(start.plan.entities.get(id).separate, true);
  assert.equal(at(start.plan, id).position.x, target.position.x);
  assert.equal(at(start.plan, id).position.z, target.position.z);
  assert.equal(start.cue.kind, 'meld');
  equalPose(at(f.draw(640).plan, id), target);
});

test('retired/revoked visible entitlements are purged at publication, with no retained faces or ghost cue', t => {
  const f = fixture(t);
  f.h.snapshot([['4', thing('hand.0@0', 1)]]);
  f.draw(0);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]]);
  const drawn = f.draw(100);
  assert(drawn.cue);
  const hidden = f.h.snapshot([['h_new_back', thing('hand.0@1', null, 2)]]);
  f.motion.reconcile(hidden);
  assert.equal(f.motion.motions.size, 0, 'purging does not wait for another GPU draw');
  const current = f.draw(110);
  assert.equal(current.cue, null);
  assert.equal(f.motion.latestDiscardId, null);
  assert.equal(current.plan.entities.size, 1);
  assert.equal(f.motion.motions.size, 0);
  const serialized = JSON.stringify(f.motion);
  assert.equal(serialized.includes('faceIndex'), false);
  assert.equal(serialized.includes('appearance'), false);
});

test('animated geometry stays canonical for picking and a human can submit during another tile’s travel without waiting', t => {
  const f = fixture(t);
  f.h.snapshot([['4', thing('hand.0@0', 1)], ['72', thing('discard.0.0@1', 18)]]);
  f.draw(0);
  const frame = f.h.snapshot([['4', thing('hand.0@0', 1)], ['72', thing('discard.0.1@1', 18)]]);
  f.draw(100);
  const plan = f.draw(180).plan;
  const moving = frame.entities.find(entity => entity.seat === 1), pose = at(plan, moving.entityId);
  const modelData = f.tileModel(pose), { pickTile } = f.h.load('renderer/gpu/picking.ts');
  const hit = pickTile({ modelData, instanceCount: 1 },
    { origin: [pose.position.x, 3, -pose.position.z], direction: [0, -1, 0] });
  assert(hit, 'the actual intermediate tile, not its destination/accent, is the raycast target');
  const own = frame.entities.find(entity => entity.seat === 0);
  const { RendererActionRouter } = f.h.load('renderer/renderer-actions.ts');
  const router = new RendererActionRouter(f.h.adapter, { result() {}, notice() {}, unavailable() {} });
  f.h.sockets.at(-1).sent.length = 0;
  assert.equal(router.handle({
    contractVersion: '1.0.0', instanceId: frame.instanceId, sessionId: frame.sessionId,
    type: 'action', actionId: 'during-travel', contextFrameId: frame.frameId,
    intent: { kind: 'discard', entityId: own.entityId },
  }).status, 'submitted');
  assert.deepEqual(f.h.sockets.at(-1).sent.flatMap(packet => packet.entries ?? []).filter(([kind]) => kind === 'discard'),
    [['discard', 0, { tileId: 4 }]]);
});

test('actual Changsha landscape uses the available rectangle; hand faces grow proportionally and stay inside their own camera', t => {
  const f = fixture(t, 'separate');
  f.h.snapshot(Array.from({ length: 14 }, (_, index) => [String(index * 4), thing(`hand.${index}@0`, index)]));
  for (const [width, height] of [[844, 390], [1280, 800], [390, 844]]) {
    const view = f.viewport(width, height), plan = f.target(f.h.adapter.latest, view), frame = f.h.adapter.latest;
    const extent = plan.bounds.getSize(new Vector3());
    if (width === 844) assert(extent.x / extent.z > 3, 'a rectangular felt must replace the narrow square, not merely recolor it');
    const matrix = new Matrix4().fromArray(f.fittedCamera(plan, frame, true));
    for (const id of frame.localHand.entityIds) {
      const pose = at(plan, id), model = new Matrix4().fromArray(f.tileModel(pose));
      const project = (x, z) => new Vector3(x, z, .5).applyMatrix4(model).applyMatrix4(matrix);
      const a = project(-.5, -5 / 6), b = project(.5, 5 / 6);
      assert([a.x, b.x, a.y, b.y].every(value => Math.abs(value) < 1.001), `${width}: complete tile edges remain in the hand band`);
      const tileWidth = Math.abs(b.x - a.x) * plan.hand.width / 2;
      const tileHeight = Math.abs(b.y - a.y) * plan.hand.height / 2;
      assert(Math.abs(tileHeight / tileWidth - 1.5) < .001, 'no nonuniform stretching of the licensed faces');
      if (width === 844) assert(tileWidth > 50, 'landscape hand tiles no longer stop at the old 44px cap');
    }
  }
});

test('the fourteen-tile hand rail keeps existing tiles fixed across a real draw and reserves a conspicuous drawn-tile gap', t => {
  for (const withMeld of [false, true]) {
    const f = fixture(t, 'separate'), count = withMeld ? 10 : 13;
    const exposed = withMeld ? Array.from({ length: 3 }, (_, index) =>
      [String((index + 1) * 4), thing(`meld.0.${index}@0`, 1)]) : [];
    const rows = Array.from({ length: count }, (_, index) =>
      [String((index + 4) * 4), thing(`hand.${index}@0`, index + 4)]);
    const first = f.h.snapshot([...exposed, ...rows], { phase: 'AwaitingClaim' }), before = f.target();
    const withDraw = f.h.snapshot([...exposed, ...rows, ['0', thing(`hand.${count}@0`, 0)]]);
    assert(withDraw.localHand.drawnEntityId, 'the production World must identify the newly drawn tile');
    const after = f.target();
    for (const entity of first.entities) equalPose(at(before, entity.entityId), at(after, entity.entityId));
    const order = withDraw.localHand.entityIds.filter(id => id !== withDraw.localHand.drawnEntityId);
    const last = at(after, order.at(-1)), drawn = at(after, withDraw.localHand.drawnEntityId);
    assert(drawn.position.x - last.position.x > .06 * drawn.scale * 1.4);
  }
});

test('a public draw gives actor/action feedback without revealing its tile or erasing the static last discard; a meld clears that marker', t => {
  const f = fixture(t);
  f.h.snapshot([['4', thing('hand.0@0', 1)]]);
  f.draw(0);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)]], { activeSeat: 0, phase: 'AwaitingClaim' });
  const discarded = f.draw(100).cue.entityId;
  f.h.snapshot([['4', thing('discard.0.0@0', 1)], ['h_drawn', thing('hand.0@1', null, 2)]], { activeSeat: 1 });
  const draw = f.draw(800);
  assert.equal(draw.cue.kind, 'draw');
  assert.equal(draw.cue.seat, 1);
  assert.equal(draw.cue.entityId, null, 'only a public hand count, never a hidden-ID link, establishes the draw');
  assert.equal(f.motion.latestDiscardId, discarded);
  assert.equal(f.draw(1451).cue, null);
  assert.equal(f.motion.latestDiscardId, discarded);
  f.h.snapshot([['4', thing('meld.0.0@1', 1)], ['h_drawn', thing('hand.0@1', null, 2)]], { activeSeat: 1 });
  const meld = f.draw(1500);
  assert.equal(meld.cue.kind, 'meld', 'public data does not invent Pong/Kong/Chi specificity');
  assert.equal(meld.cue.sourceSeat, 0);
  assert.equal(f.motion.latestDiscardId, null);
});

test('an ambiguous multi-discard snapshot cannot invent a latest discard or restart action context', t => {
  const f = fixture(t);
  f.h.snapshot([]); f.draw(0);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)], ['8', thing('discard.0.0@1', 2)]]);
  assert.equal(f.draw(100).cue, null);
  assert.equal(f.motion.latestDiscardId, null);
  f.h.snapshot([['4', thing('discard.0.0@0', 1)], ['8', thing('discard.0.0@1', 2)], ['12', thing('discard.0.1@1', 3)]]);
  assert.equal(f.draw(400).cue.kind, 'discard');
  assert.equal(f.motion.latestDiscardId, f.h.adapter.latest.entities.find(entity => entity.slotName === 'discard.0.1@1').entityId);
});
