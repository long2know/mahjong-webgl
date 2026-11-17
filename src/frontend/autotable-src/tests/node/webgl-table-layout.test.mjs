import test from 'node:test';
import assert from 'node:assert/strict';
import { changshaTableFixture, plain, require } from './renderer-test-support.mjs';
const { Box3, Matrix4, Vector3 } = require('three');

const profiles = [
  ['reference-viewport', 1791, 790, 0, 60], ['reference-board-crop', 1791, 1030, 0, 60],
  ['sidebar', 1280, 800, 348, 60], ['focused', 1280, 800, 0, 60],
  ['landscape', 844, 390, 0, 58], ['portrait', 390, 844, 0, 88],
  ['ultrawide', 3440, 1440, 0, 60],
];
function geometry(fixture) {
  const { h } = fixture;
  const layout = h.load('renderer/webgl-layout.ts'), mesh = h.load('renderer/gpu/tile-mesh.ts');
  const { rendererViewport } = h.load('renderer/renderer-viewport.ts');
  const points = pose => {
    const matrix = new Matrix4().fromArray(layout.tileModel(pose)), result = [];
    for (const x of [-mesh.TILE_WIDTH / 2, mesh.TILE_WIDTH / 2])
      for (const y of [-mesh.TILE_HEIGHT / 2, mesh.TILE_HEIGHT / 2])
        for (const z of [-mesh.TILE_DEPTH / 2, mesh.TILE_DEPTH / 2])
          result.push(new Vector3(x, y, z).applyMatrix4(matrix));
    return result;
  };
  const bounds = pose => new Box3().setFromPoints(points(pose).map(point => { point.z *= -1; return point; }));
  const viewport = ([, width, height, right, top]) => rendererViewport(h.adapter.instanceId, 1, {
    width, height, dpr: 1, separateHand: true, insets: { top, right, bottom: 0, left: 0 },
  });
  return { ...layout, points, bounds, viewport };
}
const gap = (a, b) => Math.hypot(
  Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x), Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z));
const near = (a, b, label) => assert(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`);
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('complete two-tier walls keep canonical corner contacts across aspect, focus, camera and viewer rotation', t => {
  const fixture = changshaTableFixture({ completeWall: true });
  t.after(fixture.h.close);
  const g = geometry(fixture), { layout, frame } = fixture;
  assert.equal(frame.entities.length, 108);
  const source = plain(frame);
  for (const profile of profiles) for (const viewSeat of [0, 1, 2, 3]) for (const viewMode of ['flat', 'perspective']) {
    const current = plain(frame);
    current.session.viewSeat = viewSeat; current.presentation.viewMode = viewMode;
    const plan = g.buildWebglPlan(layout, current, g.viewport(profile));
    const entities = new Map([...plan.entities.values()].map(item => [item.entity.slotName, item]));
    assert.equal(entities.size, 108);
    for (const [seat, stacks] of [[0, 14], [1, 14], [2, 13], [3, 13]]) {
      const last = entities.get(`wall.${stacks - 1}.0@${seat}`), next = entities.get(`wall.0.0@${(seat + 1) % 4}`);
      near(gap(g.bounds(last.pose), g.bounds(next.pose)), 0, `${profile[0]}/${viewSeat}: windmill corner`);
      for (let stack = 0; stack < stacks; stack++) {
        const bottom = entities.get(`wall.${stack}.0@${seat}`), top = entities.get(`wall.${stack}.1@${seat}`);
        const lower = g.bounds(bottom.pose), upper = g.bounds(top.pose);
        near(lower.max.y, upper.min.y, 'stack tiers touch, not float');
        near(lower.min.x, upper.min.x, 'stack X'); near(lower.min.z, upper.min.z, 'stack Z');
        assert(plan.bounds.clone().expandByScalar(1e-6).containsBox(lower), 'wall stays on the actual table');
        const slot = plan.slots.get(bottom.entity.slotName);
        near(gap(lower, g.bounds(slot.poses[0])), 0, 'wall picking slot shares the displayed frame');
      }
    }
  }
  assert.deepEqual(plain(frame), source, 'presentation cannot mutate the authoritative frame');
});

test('remaining wall holes and four compact rivers stay truthful and coherent when surplus felt grows', t => {
  const fixture = changshaTableFixture();
  t.after(fixture.h.close);
  const g = geometry(fixture), { frame, layout } = fixture;
  assert.equal(frame.entities.length, 108);
  assert.equal(frame.entities.filter(entity => entity.group === 'wall').length, 51);
  const source = plain(frame);
  for (const viewSeat of [0, 1, 2, 3]) {
    let core = null, regions = null;
    for (const profile of profiles) {
      const current = plain(frame); current.session.viewSeat = viewSeat;
      const plan = g.buildWebglPlan(layout, current, g.viewport(profile));
      const physical = [...plan.entities.values()].filter(item => item.entity.group === 'wall' || item.entity.group === 'discard');
      const next = plain(physical.map(item => [item.entity.entityId, g.tileModel(item.pose)]));
      if (core) assert.deepEqual(next, core, `${profile[0]} must not pull complete wall sides or river quadrants apart`);
      core = next;
      if (regions) assert.deepEqual(plain([...plan.rivers]), regions);
      regions = plain([...plan.rivers]);
      assert.equal(physical.length, 55, 'consumed slots must never be refilled with cosmetic backs');
      assert(!physical.some(item => item.entity.slotName.endsWith('@1') && item.entity.group === 'wall'));
      assert(!physical.some(item => item.entity.slotName === 'wall.9.1@2'), 'a consumed upper tier remains missing');
      assert(physical.some(item => item.entity.slotName === 'wall.9.0@2'), 'the remaining lower tier stays present');
      for (const placement of physical) {
        const box = g.bounds(placement.pose);
        if (placement.entity.group === 'discard') {
          const region = plan.rivers.get(placement.entity.seat);
          assert(box.min.x >= region.min.x - 1e-6 && box.max.x <= region.max.x + 1e-6
            && box.min.z >= region.min.z - 1e-6 && box.max.z <= region.max.z + 1e-6,
          `${profile[0]}: actual discard corners fit their own river, including the innermost row`);
        }
      }
      const cluster = new Box3();
      for (const river of plan.rivers.values()) cluster.union(river);
      assert(cluster.getSize(new Vector3()).x < .735 && cluster.getSize(new Vector3()).z < .735,
        'all four rivers form one cluster inside the canonical wall opening');
      for (const slot of plan.slots.values()) if (slot.slot.group === 'discard' && slot.slot.indexes.length === 2) {
        const box = g.bounds(slot.poses[0]), region = plan.rivers.get(slot.slot.seat);
        assert(box.min.x >= region.min.x - 1e-6 && box.max.x <= region.max.x + 1e-6
          && box.min.z >= region.min.z - 1e-6 && box.max.z <= region.max.z + 1e-6,
        'all offered discard target corners use the same compact coordinate core');
      }
    }
  }
  assert.deepEqual(plain(frame), source);
});

test('occupied seat bounds, projected labels and retained picking follow actual mesh corners after every reflow', t => {
  const fixture = changshaTableFixture();
  t.after(fixture.h.close);
  const g = geometry(fixture), { layout, frame } = fixture;
  const { seatLabelRect } = fixture.h.load('renderer/webgl-scene.ts');
  const { pickTile, invertMatrix4 } = fixture.h.load('renderer/gpu/picking.ts');
  for (const profile of profiles) for (const viewMode of ['flat', 'perspective']) {
    const current = plain(frame); current.presentation.viewMode = viewMode;
    const plan = g.buildWebglPlan(layout, current, g.viewport(profile)), camera = g.fittedCamera(plan, current);
    const matrix = new Matrix4().fromArray(camera), obstacles = [...plan.groups.values(), ...plan.rivers.values()]
      .map(box => g.projectTableBounds(box, plan.board, camera));
    for (const item of plan.entities.values()) if (!item.separate) {
      const group = plan.groups.get(`${item.entity.seat}:${item.entity.group}`);
      assert(group?.clone().expandByScalar(1e-6).containsBox(g.bounds(item.pose)), 'row bounds contain the actual current tile meshes');
      for (const point of g.points(item.pose).map(point => point.applyMatrix4(matrix))) {
        assert(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1, `${profile[0]}: actual table tile must not be cropped`);
      }
    }
    for (const seat of [0, 1, 2, 3]) {
      const hand = new Box3();
      for (const group of ['hand', 'meld']) {
        const box = plan.groups.get(`${seat}:${group}`); if (box) hand.union(box);
      }
      const label = seatLabelRect(plan.board, hand.isEmpty() ? null : g.projectTableBounds(hand, plan.board, camera),
        seat, Math.min(115, plan.board.width * .19), 26, obstacles);
      assert(label.x >= plan.board.x && label.x + label.width <= plan.board.x + plan.board.width);
      assert(label.y >= plan.board.y && label.y + label.height <= plan.board.y + plan.board.height);
      assert(obstacles.every(other => !overlaps(label, other)), `${profile[0]}/${viewMode}/seat${seat}: labels must not cover physical rows or rivers`);
      obstacles.push(label);
    }
    const target = [...plan.entities.values()].find(item => item.entity.group === 'discard');
    const point = target.pose.position.clone(); point.z *= -1; point.applyMatrix4(matrix);
    const inverse = new Matrix4().fromArray(invertMatrix4(camera));
    const origin = new Vector3(point.x, point.y, -1).applyMatrix4(inverse);
    const direction = new Vector3(point.x, point.y, 1).applyMatrix4(inverse).sub(origin).normalize();
    const tiles = [...plan.entities.values()].filter(item => !item.separate);
    const data = new Float32Array(tiles.length * 16);
    tiles.forEach((item, index) => data.set(g.tileModel(item.pose), index * 16));
    const hit = pickTile({ modelData: data, instanceCount: tiles.length }, {
      origin: origin.toArray(), direction: direction.toArray(),
    });
    assert.equal(tiles[hit?.instanceIndex]?.entity.entityId, target.entity.entityId,
      `${profile[0]}: the actual projected discard remains the retained ray hit after reflow`);
  }
});

test('seat labels avoid the displayed onset and intermediate meshes of both bot discard arrivals across cameras and viewer rotations', t => {
  const fixture = changshaTableFixture();
  t.after(fixture.h.close);
  const g = geometry(fixture), { WebglScene } = fixture.h.load('renderer/webgl-scene.ts');
  const { WebglPresentation } = fixture.h.load('renderer/webgl-presentation.ts');
  class Label {
    style = { setProperty() {} };
    dataset = {};
    hidden = false;
    attributes = new Map();
    get offsetWidth() { return Math.min(144, Number(/([\d.]+)px/.exec(this.style.maxWidth)?.[1] ?? 144)); }
    get offsetHeight() { return 27.1875; }
    append() {}
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
  }
  fixture.h.context.document.createElement = () => new Label();
  for (const profile of profiles) for (const viewMode of ['flat', 'perspective'])
    for (const viewSeat of [0, 1, 2, 3]) for (const seat of [1, 3]) {
      const before = plain(fixture.frame), index = before.entities.findIndex(entity => entity.group === 'discard' && entity.seat === seat);
      const discarded = plain(before.entities[index]);
      const count = before.entities.filter(entity => entity.group === 'hand' && entity.seat === seat).length;
      const slot = fixture.layout.slots.find(slot => slot.slotName === `hand.${count}@${seat}`);
      before.entities[index] = {
        ...plain(discarded), entityId: `entity_${String(seat).repeat(32)}`, group: 'hand',
        slotName: slot.slotName, indexes: [count], rotationIndex: 2, pose: plain(slot.poses[2]),
        appearance: { faceIndex: null, knownFace: false, showFace: false, backIndex: 0, valueIndex: null },
      };
      before.session.viewSeat = viewSeat; before.presentation.viewMode = viewMode;
      before.seats.forEach(player => { player.nick = `Table player ${player.seat + 1} with a long nickname`; });
      const accepted = plain(before);
      accepted.entities[index] = discarded;
      const unchanged = plain(accepted), viewport = g.viewport(profile), presentation = new WebglPresentation();
      presentation.apply(g.buildWebglPlan(fixture.layout, before, viewport), before, viewport, 0, false);
      const scene = Object.assign(Object.create(WebglScene.prototype), {
        labels: new Label(), labelNodes: new Map(), turnLabel: new Label(), actionLabel: new Label(),
        latestLabel: new Label(), latestTile: new Label(), latestCaption: new Label(),
        currentVisible: new Set(accepted.entities.filter(entity => entity.appearance.showFace).map(entity => entity.entityId)),
        updateMeldCallout() {},
      });
      const beforePlan = g.buildWebglPlan(fixture.layout, before, viewport);
      scene.matrices = [g.fittedCamera(beforePlan, before), g.fittedCamera(beforePlan, before, true)];
      scene.updateLabels({ frame: before, plan: beforePlan, viewport, cue: null, discardId: null, meldCallout: null });
      const labels = () => [...scene.labelNodes.values()].map(node => {
        const relative = Number(node.dataset.side);
        return { x: parseFloat(node.style.left) - (relative === 1 || relative === 2 ? node.offsetWidth : 0),
          y: parseFloat(node.style.top) - node.offsetHeight / 2, width: node.offsetWidth, height: node.offsetHeight };
      });
      for (const elapsed of [0, 16, 80, 160, 240, 319, 320]) {
        const previouslyPainted = labels();
        const plan = g.buildWebglPlan(fixture.layout, accepted, viewport), camera = g.fittedCamera(plan, accepted);
        const cue = presentation.apply(plan, accepted, viewport, 100 + elapsed, false);
        scene.matrices = [camera, g.fittedCamera(plan, accepted, true)];
        scene.updateLabels({ frame: accepted, plan, viewport, cue, discardId: presentation.latestDiscardId, meldCallout: null });
        const arrival = plan.entities.get(discarded.entityId);
        const project = pose => {
          const points = g.points(pose).map(point => point.applyMatrix4(new Matrix4().fromArray(camera)));
          const xs = points.map(point => plan.board.x + (point.x + 1) * plan.board.width / 2);
          const ys = points.map(point => plan.board.y + (1 - point.y) * plan.board.height / 2);
          return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
        };
        assert(previouslyPainted.every(label => !overlaps(label, project(arrival.pose))),
          `${profile[0]}/${viewMode}/viewer${viewSeat}/discard${seat}/${elapsed}ms: the next GPU paint must clear the PREVIOUS labels before any DOM receipt`);
        const tiles = [...plan.entities.values()].filter(item => !item.separate).map(item => project(item.pose));
        if (profile[0] === 'reference-viewport' && viewMode === 'flat' && viewSeat === 0 && elapsed === 0) {
          const point = arrival.pose.position.clone(); point.z *= -1;
          point.applyMatrix4(new Matrix4().fromArray(camera));
          assert(Math.abs((point.x + 1) * 1791 / 2 - (seat === 1 ? 1622.037718036299 : 168.9622819637009)) < .05,
            'reproduce the rejected real-play arrival X, not just settled river coordinates');
          assert(Math.abs(plan.board.y + (1 - point.y) * plan.board.height / 2 - 335) < .05,
            'reproduce the rejected real-play arrival Y');
        }
        for (const [owner, node] of scene.labelNodes) {
          const relative = Number(node.dataset.side);
          const label = { x: parseFloat(node.style.left) - (relative === 1 || relative === 2 ? node.offsetWidth : 0),
            y: parseFloat(node.style.top) - node.offsetHeight / 2, width: node.offsetWidth, height: node.offsetHeight };
          assert(label.x >= plan.board.x && label.y >= plan.board.y
            && label.x + label.width <= plan.board.x + plan.board.width
            && label.y + label.height <= plan.board.y + plan.board.height,
          'avoiding travel cannot move a seat label outside the board');
          assert(tiles.every(tile => !overlaps(label, tile)),
            `${profile[0]}/${viewMode}/viewer${viewSeat}/discard${seat}/${elapsed}ms: seat${owner} covers a displayed mesh: ${JSON.stringify({ label, arrival: project(arrival.pose) })}`);
        }
        const target = g.buildWebglPlan(fixture.layout, accepted, viewport).entities.get(discarded.entityId).pose;
        if (elapsed < 320) assert(arrival.pose.position.distanceTo(target.position) > 0, 'coverage must retain actual 320ms travel');
        else assert(arrival.pose.position.distanceTo(target.position) < 1e-8);
      }
      assert.deepEqual(plain(accepted), unchanged, 'label avoidance cannot mutate authoritative entities');
    }
});
