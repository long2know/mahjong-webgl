import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gameHarness, thing, sourceLoader, root, require } from './renderer-test-support.mjs';

function fixture(t, variant = 'CHANGSHA', handLayout = 'separate') {
  const h = gameHarness(variant); t.after(h.close); h.join();
  h.adapter.setPresentation({
    viewMode: 'flat', boardLayout: 'rectangular', handLayout, tileLabels: true, lookDown: 0, zoom: 0,
  });
  const { buildWebglPlan } = h.load('renderer/webgl-layout.ts');
  const { WebglPresentation } = h.load('renderer/webgl-presentation.ts');
  const { rendererViewport } = h.load('renderer/renderer-viewport.ts');
  const viewport = rendererViewport(h.adapter.instanceId, 1, {
    width: 844, height: 390, dpr: 1, separateHand: handLayout === 'separate', insets: { top: 60, left: 0, right: 0, bottom: 0 },
  });
  const motion = new WebglPresentation();
  const draw = (time, frame = h.adapter.latest) => {
    const plan = buildWebglPlan(h.adapter.layout, frame, viewport), cue = motion.apply(plan, frame, viewport, time);
    return { frame, plan, viewport, cue, discardId: motion.latestDiscardId, meldCallout: motion.meldCallout, milliseconds: 0 };
  };
  return { h, motion, draw, viewport };
}
function meld(faces, { seat = 1, group = 0, positions = faces.map((_, index) => index), concealed = false, prefix = 'h_kong' } = {}) {
  const used = new Map();
  return faces.map((face, index) => {
    const occurrence = used.get(face) ?? 0; used.set(face, occurrence + 1);
    return [concealed ? `${prefix}_${index}` : String(face * 4 + occurrence),
      thing(`meld.${group}.${positions[index]}@${seat}`, concealed ? null : face, concealed ? 2 : 0)];
  });
}

test('accepted canonical Pung and same-suit Chow words belong to the meld owner, not the next active seat', t => {
  for (const [faces, kind] of [[[4, 4, 4], 'pung'], [[9, 10, 11], 'chow']]) {
    const f = fixture(t); f.h.snapshot([]); f.draw(0);
    f.h.snapshot(meld(faces), { activeSeat: 2 });
    const commit = f.draw(100);
    assert.equal(commit.meldCallout.kind, kind);
    assert.equal(commit.meldCallout.seat, 1);
    assert.equal(commit.frame.turn.activeSeat, 2);
    assert.equal(commit.cue.kind, 'meld', 'the existing small public cue is retained separately');
    assert.equal(f.h.sockets.at(-1).sent.some(packet => packet.entries?.some(([kind]) => kind === 'claim')), false,
      'observing acceptance must not submit or repeat a claim');
  }
});

test('exposed and four-back concealed Kongs classify before the visible-tile movement filter', t => {
  for (const concealed of [false, true]) {
    const f = fixture(t); f.h.snapshot([]); f.draw(0);
    f.h.snapshot(meld([5, 5, 5, 5], { concealed }));
    const commit = f.draw(100);
    assert.equal(commit.meldCallout.kind, 'kong');
    if (concealed) {
      assert(commit.frame.entities.every(entity => !entity.appearance.knownFace && !entity.appearance.showFace));
      assert.equal(f.motion.motions.size, 0, 'concealed entities never enter the visible travel cache');
      const retained = JSON.stringify([...f.motion.melds]);
      assert(!retained.includes('face') && !retained.includes('h_kong') && !retained.includes('entity_'));
      f.h.snapshot(meld([5, 5, 5, 5], { concealed, prefix: 'h_rekeyed' }));
      assert.equal(f.draw(200).meldCallout, commit.meldCallout, 'changing opaque hidden handles does not create another accepted Kong');
    }
  }
});

test('pending or robbed added Kong leaves the old Pung unchanged; only accepted fourth-slot 4 upgrades announce Kong', t => {
  const f = fixture(t), pung = meld([5, 5, 5]);
  f.h.snapshot(pung); assert.equal(f.draw(0).meldCallout, null);
  const pending = [...pung, ['h_pending_fourth', thing('hand.0@1', null, 2)]];
  f.h.snapshot(pending, { activeSeat: 1, phase: 'DeclaringKong' });
  assert.equal(f.draw(100).meldCallout, null);
  f.h.snapshot(pending, { activeSeat: 2, phase: 'AwaitingClaim' });
  assert.equal(f.draw(300).meldCallout, null, 'a robbing-Kong claim window is not acceptance');
  f.h.snapshot(pung, { activeSeat: null, phase: 'Scoring' });
  assert.equal(f.draw(500).meldCallout, null, 'a robbed upgrade never grew a fourth public meld member');
  f.h.snapshot(meld([5, 5, 5, 5], { positions: [0, 1, 2, 4] }), { activeSeat: 1 });
  assert.equal(f.draw(700).meldCallout.kind, 'kong');
  const accepted = f.motion.meldCallout;
  f.h.snapshot(meld([5, 5, 5, 5], { positions: [0, 1, 2, 4] }), { activeSeat: 1 });
  assert.equal(f.draw(900).meldCallout, accepted, 'identical accepted added-Kong FULLs do not restart it');
});

test('incomplete, noncanonical and contradictory groups fall back to Meld; ambiguous actors and relay layouts cannot invent specific words', t => {
  const cases = [
    { faces: [7, 8, 9] }, { faces: [1, 3, 4] }, { faces: [1, 1, 2] }, { faces: [3, 3] },
    { faces: [3, 3, 3], positions: [0, 1, 4] }, { faces: [3, 3, 3], concealed: true },
    { faces: [3, 3, 3, 4] }, { faces: [3, 3, 3, 3], positions: [0, 1, 3, 4] },
  ];
  for (const { faces, ...options } of cases) {
    const f = fixture(t); f.h.snapshot([]); f.draw(0);
    f.h.snapshot(meld(faces, options));
    assert.equal(f.draw(100).meldCallout.kind, 'meld', JSON.stringify({ faces, ...options }));
  }
  const ambiguous = fixture(t); ambiguous.h.snapshot([]); ambiguous.draw(0);
  ambiguous.h.snapshot([...meld([1, 1, 1]), ...meld([2, 2, 2], { seat: 2 })]);
  assert.equal(ambiguous.draw(100).meldCallout, null, 'two changed actors have no provable latest owner');
  const oneActor = fixture(t); oneActor.h.snapshot([]); oneActor.draw(0);
  oneActor.h.snapshot([...meld([1, 1, 1]), ...meld([2, 2, 2], { group: 1 })]);
  assert.equal(oneActor.draw(100).meldCallout.kind, 'meld', 'multiple changed groups on one actor do not guess chronology');
  const relay = fixture(t, 'FOUR_PLAYER'); relay.h.snapshot([]); relay.draw(0);
  relay.h.snapshot(meld([1, 1, 1]));
  assert.equal(relay.draw(100).meldCallout, null, 'free relay arrangements cannot prove an accepted Changsha rule action');
});

test('initial and duplicate FULLs stay silent; later draws/discards preserve one fresh meld callout for its full hold', t => {
  const f = fixture(t), initial = meld([1, 1, 1]), accepted = [...initial, ...meld([2, 2, 2], { group: 1 })];
  f.h.snapshot(initial); assert.equal(f.draw(0).meldCallout, null);
  f.h.snapshot(initial); assert.equal(f.draw(100).meldCallout, null);
  f.h.snapshot(accepted); const callout = f.draw(200).meldCallout;
  f.h.snapshot(accepted); assert.equal(f.draw(300).meldCallout, callout);
  f.h.snapshot([...accepted, ['h_draw', thing('hand.0@2', null, 2)]], { activeSeat: 2 });
  const drawn = f.draw(500);
  assert.equal(drawn.cue.kind, 'draw'); assert.equal(drawn.meldCallout, callout);
  f.h.snapshot([...accepted, ['12', thing('discard.0.0@2', 3)]], { activeSeat: 2, phase: 'AwaitingClaim' });
  const discarded = f.draw(800);
  assert.equal(discarded.cue.kind, 'discard'); assert.equal(discarded.meldCallout, callout);
  assert.equal(f.draw(1249).meldCallout, callout);
  assert.equal(f.draw(1250).meldCallout, null);
  assert.equal(f.motion.latestDiscardId, discarded.discardId, 'expiring the comic word must not clear discard context');
});

test('publication privacy loss, reconnect/reset and bursts clear or replace the bounded public summary without keeping faces or retired IDs', t => {
  const f = fixture(t); f.h.snapshot([]); f.draw(0);
  f.h.snapshot(meld([1, 1, 1])); assert(f.draw(100).meldCallout);
  const hidden = f.h.snapshot(meld([1, 1, 1], { concealed: true }));
  f.motion.reconcile(hidden);
  assert.equal(f.motion.meldCallout, null, 'precise face entitlement loss purges before the next draw');
  f.draw(150);
  f.h.snapshot([]); f.motion.reconcile(f.h.adapter.latest);
  assert.equal(f.motion.meldCallout, null);
  f.draw(160);
  let latest;
  for (let index = 0; index < 12; index++) {
    f.h.snapshot(meld([index + 2, index + 2, index + 2], { group: index % 4 }));
    latest = f.draw(200 + index * 10).meldCallout;
    assert(latest); assert.equal(f.motion.melds.size, 1);
    assert.equal(f.motion.motions.size, 3);
    for (const group of f.motion.melds.values()) {
      assert.equal('faces' in group || 'entityIds' in group || 'appearance' in group, false);
    }
  }
  assert.equal(f.motion.meldCallout, latest);
  f.h.delta([], { rev: 2 }); f.motion.reconcile(f.h.adapter.latest);
  assert.equal(f.motion.meldCallout, null);
  f.draw(400);
  f.h.snapshot(meld([1, 1, 1]), { rev: 2 });
  assert.equal(f.draw(500).meldCallout, null);
  f.motion.clear();
  assert.equal(f.motion.melds.size, 0);
  assert.equal(f.draw(600).meldCallout, null);
  f.h.client.disconnect(); f.motion.clear(); f.h.join('new-room', 0);
  f.h.snapshot(meld([1, 1, 1]));
  assert.equal(f.draw(700).meldCallout, null);
});

class Label extends EventTarget {
  constructor(rect = { left: 0, top: 0, width: 128, height: 56 }) {
    super(); this.rect = rect; this.children = []; this.attributes = new Map(); this.dataset = {}; this.hidden = false;
    this.properties = new Map(); this.replaced = 0;
    this.style = { setProperty: (key, value) => this.properties.set(key, value) };
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.replaced++; }
  get offsetWidth() { return this.rect.width; }
  get offsetHeight() { return this.rect.height; }
  getBoundingClientRect() { return this.rect; }
}
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('production seat callout placement stays in board/visual-viewport bounds at all relative seats and yields to claims/hand space', t => {
  const f = fixture(t), { meldCalloutRect } = f.h.load('renderer/webgl-scene.ts');
  for (const board of [
    { x: 0, y: 90, width: 390, height: 574 }, { x: 0, y: 60, width: 844, height: 231 },
    { x: 20, y: 60, width: 627, height: 154 }, { x: 10, y: 80, width: 900, height: 520 },
  ]) {
    const visual = { x: board.x + 3, y: board.y + 2, width: board.width - 6, height: board.height - 4 };
    for (let side = 0; side < 4; side++) {
      const anchors = [[.025, .95], [.975, .5], [.975, .055], [.025, .5]];
      const width = Math.min(140, board.width * .19), height = 24;
      const seat = { x: board.x + board.width * anchors[side][0] - (side === 1 || side === 2 ? width : 0),
        y: board.y + board.height * anchors[side][1] - height / 2, width, height };
      const rect = meldCalloutRect(board, seat, side, 128, 56, visual);
      assert(rect, `${JSON.stringify(board)}/${side}`);
      assert(rect.x >= visual.x && rect.y >= visual.y);
      assert(rect.x + rect.width <= visual.x + visual.width && rect.y + rect.height <= visual.y + visual.height);
      assert(rect.y + rect.height < board.y + board.height, 'the independent hand begins below the board');
      assert(!overlaps(rect, seat));
      const claimed = meldCalloutRect(board, seat, side, 128, 56, visual, [rect]);
      assert(!claimed || !overlaps(claimed, rect), 'a claim-control rectangle must not be covered');
      assert.equal(meldCalloutRect(board, seat, side, 128, 56, visual, [board]), null);
    }
  }
});

test('real scene label updates do not restart duplicate cues, respect explicit motion preferences, expire statically and never replace controls', t => {
  const f = fixture(t, 'CHANGSHA', 'in-table'); let now = 100;
  f.h.context.performance = { now: () => now };
  const document = f.h.context.document, controls = new Label({ left: 0, top: 0, width: 0, height: 0 });
  document.body = new Label();
  document.createElement = () => new Label();
  document.querySelectorAll = () => [];
  document.getElementById = id => id === 'claim-window-actions' ? controls : null;
  f.h.context.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  f.h.context.window.innerWidth = 844; f.h.context.window.innerHeight = 390;
  f.h.context.window.matchMedia = () => ({ matches: true });
  const theme = f.h.load('theme.ts'); theme.setMotionPreference('full');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/en.json'), 'utf8'));
  f.h.load('i18n.ts').t = key => catalog[key] ?? key;
  const { WebglScene } = f.h.load('renderer/webgl-scene.ts');
  const { fittedCamera } = f.h.load('renderer/webgl-layout.ts');
  const own = ['0', thing('hand.0@0', 0)];
  f.h.snapshot([own]); f.draw(0);
  f.h.snapshot([own, ...meld([4, 4, 4])], { activeSeat: 2 });
  const commit = f.draw(100), label = new Label(), scene = Object.assign(Object.create(WebglScene.prototype), {
    presentation: f.motion, meldLabel: label, meldToken: null, meldReduced: null,
    canvas: new Label({ left: 0, top: 0, width: 844, height: 390 }),
    matrices: [fittedCamera(commit.plan, commit.frame), fittedCamera(commit.plan, commit.frame, true)],
    labelNodes: new Map([[1, new Label({ left: 680, top: 163, width: 140, height: 24 })]]),
  });
  scene.updateMeldCallout(commit);
  assert.equal(label.hidden, false);
  assert.equal(label.dataset.reduced, 'false', 'explicit full overrides the OS preference');
  assert.equal(label.getAttribute('aria-label'), 'S · Pung!');
  const bounds = { x: parseFloat(label.style.left), y: parseFloat(label.style.top), width: label.offsetWidth, height: label.offsetHeight };
  assert(scene.handObstacles(commit).length > 0);
  assert(scene.handObstacles(commit).every(hand => !overlaps(bounds, hand)), 'even an explicit in-table hand is protected using committed tile geometry');
  const word = label.children[0], replacements = label.replaced;
  now = 200; scene.updateMeldCallout(commit);
  assert.equal(label.replaced, replacements); assert.equal(label.children[0], word);
  theme.setMotionPreference('reduced'); scene.updateMeldCallout(commit);
  assert.equal(label.dataset.reduced, 'true'); assert.equal(label.children[0], word);
  assert.equal(label.properties.get('--meld-delay'), '-100ms');
  now = 300; theme.setMotionPreference('full'); scene.updateMeldCallout(commit);
  assert.equal(label.dataset.reduced, 'false');
  assert.equal(label.properties.get('--meld-delay'), '-200ms');
  const css = fs.readFileSync(path.join(root, 'src/renderer/webgl-host.css'), 'utf8');
  assert.match(css, /\.webgl-meld-callout\[data-reduced="true"\] \.webgl-meld-word\s*\{[^}]*animation:\s*none\s*!important/s);
  assert.match(css, /\.webgl-meld-callout\s*\{[^}]*pointer-events:\s*none/s);
  assert.equal(label.getAttribute('tabindex'), null);
  assert.equal(controls.children.length, 0);
  now = 1150; scene.updateMeldCallout(commit);
  assert.equal(label.hidden, true, 'static/reduced-motion words still expire at the same deadline');
  assert.equal(label.children.length, 0);
});

function placementFixture(t) {
  const f = fixture(t); let now = 0;
  f.h.context.performance = { now: () => now };
  class SeatLabel extends Label {
    getBoundingClientRect() {
      const width = Math.min(160, 20 + (this.textContent?.length ?? 0) * 5.2), height = 24;
      return {
        left: parseFloat(this.style.left ?? '0') - (['1', '2'].includes(this.dataset.side) ? width : 0),
        top: parseFloat(this.style.top ?? '0') - height / 2, width, height,
      };
    }
  }
  const document = f.h.context.document;
  document.body = new Label();
  document.createElement = () => new SeatLabel();
  document.querySelectorAll = () => [];
  document.getElementById = () => null;
  f.h.context.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  f.h.context.window.innerWidth = 844; f.h.context.window.innerHeight = 390;
  f.h.context.window.matchMedia = () => ({ matches: true });
  f.h.load('theme.ts').setMotionPreference('reduced');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/en.json'), 'utf8'));
  f.h.load('i18n.ts').t = key => catalog[key] ?? key;
  const { WebglScene, meldCalloutRect } = f.h.load('renderer/webgl-scene.ts');
  const { fittedCamera } = f.h.load('renderer/webgl-layout.ts');
  const label = new Label({ left: 0, top: 0, width: 119.5625, height: 51.28125 });
  const canvas = new Label({ left: 0, top: 0, width: 844, height: 390 });
  const scene = Object.assign(Object.create(WebglScene.prototype), {
    presentation: f.motion, meldLabel: label, meldToken: null, meldReduced: null, canvas,
    labels: new Label(), labelNodes: new Map(), turnLabel: new Label(), actionLabel: new Label(),
    latestLabel: new Label(), latestTile: new Label(), latestCaption: new Label(), currentVisible: new Set(),
  });
  const place = (commit, time) => {
    now = time;
    scene.matrices = [fittedCamera(commit.plan, commit.frame), fittedCamera(commit.plan, commit.frame, true)];
    scene.updateLabels(commit);
    return commit;
  };
  const render = time => place(f.draw(time), time);
  const rect = () => ({ x: parseFloat(label.style.left), y: parseFloat(label.style.top),
    width: label.offsetWidth, height: label.offsetHeight });
  const expected = commit => {
    const seat = scene.labelNodes.get(commit.meldCallout.seat).getBoundingClientRect();
    const view = f.h.context.window.visualViewport, surface = canvas.getBoundingClientRect();
    const rect = meldCalloutRect(commit.plan.board,
      { x: seat.left - surface.left, y: seat.top - surface.top, width: seat.width, height: seat.height },
      (commit.meldCallout.seat - (commit.frame.session.viewSeat ?? 0) + 4) % 4, label.offsetWidth, label.offsetHeight,
      { x: (view?.offsetLeft ?? 0) - surface.left, y: (view?.offsetTop ?? 0) - surface.top,
        width: view?.width ?? f.h.context.window.innerWidth, height: view?.height ?? f.h.context.window.innerHeight });
    assert(rect, 'the current board has a valid owner placement');
    return { ...rect };
  };
  const roster = name => [['seats', 'bot-three', { seat: 3 }], ['nicks', 'bot-three', name]];
  return { ...f, scene, label, canvas, place, render, rect, expected, roster };
}

test('same-lifecycle reduced callout placement survives small-cue expiry and following draw/discard label changes', t => {
  const f = placementFixture(t), accepted = meld([9, 10, 11], { seat: 3 }), extra = f.roster('LotusTiger');
  f.h.snapshot([], { activeSeat: 3, extra }); f.render(0);
  f.h.snapshot(accepted, { activeSeat: 3, extra });
  const first = f.render(100), position = f.rect(), word = f.label.children[0];
  assert.deepEqual(position, f.expected(first), 'the first visible position is beside the accepted owner');
  const ownerWidth = f.scene.labelNodes.get(3).getBoundingClientRect().width;
  const stable = commit => {
    assert.equal(commit.meldCallout, first.meldCallout);
    assert.equal(f.label.hidden, false);
    assert.equal(f.label.dataset.reduced, 'true');
    assert.equal(f.label.children[0], word, 'ordinary move cues must not restart the comic word');
    assert.deepEqual(f.rect(), position, 'one accepted lifecycle must keep its first visible placement');
    assert.equal(commit.meldCallout.until, 1150, 'placement must not extend the 1050ms lifetime');
  };
  stable(f.render(749));
  const expiredCue = f.render(751);
  assert.equal(expiredCue.cue, null, 'the independent 650ms Meld cue has expired');
  assert(f.scene.labelNodes.get(3).getBoundingClientRect().width < ownerWidth, 'the measured owner label really narrowed');
  stable(expiredCue);
  const drawn = ['0', thing('hand.0@0', 0)];
  f.h.snapshot([...accepted, drawn], { activeSeat: 0, extra });
  const draw = f.render(800);
  assert.equal(draw.cue.kind, 'draw'); stable(draw);
  f.h.snapshot([...accepted, drawn, ['12', thing('discard.0.0@3', 3)]],
    { activeSeat: 0, phase: 'AwaitingClaim', extra });
  const discard = f.render(900);
  assert.equal(discard.cue.kind, 'discard'); stable(discard);
  stable(f.render(1149));
  f.render(1150);
  assert.equal(f.label.hidden, true, 'the original deadline still expires the static callout');
});

test('callout placement starts anew for repeated group lifecycles and session/viewer/viewport/layout geometry resets', t => {
  const f = placementFixture(t), accepted = meld([9, 10, 11], { seat: 3 });
  f.h.snapshot([], { activeSeat: 3, extra: f.roster('LotusTiger') }); f.render(0);
  f.h.snapshot(accepted, { activeSeat: 3, extra: f.roster('LotusTiger') });
  const first = f.render(100), original = f.rect();
  f.h.snapshot(accepted, { activeSeat: 3, extra: f.roster('CloudCraneAndLotusTiger') });
  const next = { ...f.draw(200), meldCallout: { ...first.meldCallout, started: 200, until: 1250 } };
  f.motion.callout = next.meldCallout;
  f.place(next, 200);
  assert.equal(next.meldCallout.key, first.meldCallout.key);
  assert.deepEqual(f.rect(), f.expected(next), 'a new accepted lifecycle must use the current measured owner');
  assert.notDeepEqual(f.rect(), original, 'the same group key must not retain an old lifecycle position');

  let commit = next;
  const resets = [
    () => { commit = { ...commit, frame: { ...commit.frame, sessionId: 'new-placement-session' } }; },
    () => { commit = { ...commit, frame: { ...commit.frame, session: { ...commit.frame.session, viewSeat: 1, viewerRevision: 2 } } }; },
    () => { commit = { ...commit, frame: { ...commit.frame, layoutRevision: commit.frame.layoutRevision + 1 } }; },
    () => {
      f.canvas.rect.width = f.h.context.window.innerWidth = 667;
      commit = { ...commit, viewport: { ...commit.viewport, resizeRevision: 2, widthCssPx: 667 },
        plan: { ...commit.plan, board: { ...commit.plan.board, width: 667 } } };
    },
    () => { f.h.context.window.visualViewport = { offsetLeft: 12, offsetTop: 5, width: 640, height: 360 }; },
  ];
  for (const [index, reset] of resets.entries()) {
    const prior = f.rect();
    commit = { ...commit, frame: { ...commit.frame,
      seats: commit.frame.seats.map(seat => seat.seat === 3 ? { ...seat, nick: index % 2 ? 'LotusTigerAndBambooPanda' : 'JadeFox' } : seat) } };
    reset(); f.place(commit, 250 + index * 10);
    assert.equal(f.label.hidden, false);
    assert.deepEqual(f.rect(), f.expected(commit), `reset ${index} must remeasure placement`);
    if (index < 4) assert.notDeepEqual(f.rect(), prior, `reset ${index} must not reuse stale coordinates`);
  }
});

test('a reduced-motion Chow is at its new owner on the first visible DOM sample after another seat’s Kong', async t => {
  const { chromium } = require('@playwright/test'), { buildSync } = require('esbuild');
  const runtime = path.resolve(root, `../../../.work/meld-${process.pid}`);
  fs.mkdirSync(runtime, { recursive: true });
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = runtime;
  let browser;
  t.after(async () => {
    await browser?.close();
    if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  const bundle = buildSync({
    absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    loader: { '.css': 'empty' }, logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(new URL('../../src/renderer/webgl-scene.ts', import.meta.url).href) },
    stdin: { resolveDir: root, contents: `
      import { WebglScene } from './src/renderer/webgl-scene.ts';
      import { setMotionPreference } from './src/theme.ts';
      window.meldSource = { WebglScene, setMotionPreference };
    ` },
  }).outputFiles[0].text;
  const css = ['src/style.css', 'src/renderer/webgl-host.css']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-breakpad'],
    env: { ...process.env, HOME: runtime, XDG_CACHE_HOME: runtime, XDG_CONFIG_HOME: runtime },
  });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, reducedMotion: 'reduce' });
  await page.route('**/*', route => route.abort());
  await page.setContent(`<style>${css}</style>
    <div style="position:fixed;inset:0">
      <canvas width="844" height="390" style="display:block;width:100%;height:100%"></canvas>
      <div class="webgl-labels">
        <span class="webgl-seat" data-side="2" style="left:800px;top:80px;width:120px;height:24px;box-sizing:border-box">W</span>
        <span class="webgl-seat" data-side="3" style="left:20px;top:175px;width:120px;height:24px;box-sizing:border-box">N</span>
        <span class="webgl-meld-callout" hidden></span>
      </div>
    </div>`);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const { WebglScene, setMotionPreference } = window.meldSource;
    setMotionPreference('reduced');
    const label = document.querySelector('.webgl-meld-callout');
    const seats = new Map([2, 3].map(seat => [seat, document.querySelector(`[data-side="${seat}"]`)]));
    const scene = Object.assign(Object.create(WebglScene.prototype), {
      presentation: {}, meldLabel: label, meldToken: null, meldReduced: null,
      canvas: document.querySelector('canvas'), labelNodes: seats,
    });
    const show = (seat, kind) => {
      const started = performance.now(), meldCallout = { key: `${seat}:0`, seat, kind, started, until: started + 1050 };
      scene.presentation.meldCallout = meldCallout;
      scene.updateMeldCallout({
        frame: { sessionId: 'placement', session: { viewSeat: 0 }, localHand: { entityIds: [] } },
        plan: { board: { x: 0, y: 60, width: 844, height: 231 } },
        viewport: { widthCssPx: 844, heightCssPx: 390 }, meldCallout,
      });
    };
    const sample = () => {
      const rect = label.getBoundingClientRect(), style = getComputedStyle(label);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        visible: !label.hidden && style.visibility === 'visible' && rect.width > 0 && rect.height > 0,
        text: label.textContent, reduced: label.dataset.reduced,
        animations: label.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length };
    };
    show(2, 'kong');
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const previous = sample(), owner = seats.get(3).getBoundingClientRect();
    show(3, 'chow');
    const samples = [sample()];
    for (let frame = 0; frame < 3; frame++) {
      await new Promise(requestAnimationFrame); samples.push(sample());
    }
    return { previous, ownerRight: owner.right, samples, aria: label.getAttribute('aria-label') };
  });
  assert(result.previous.visible && result.previous.x > 600, 'the previous Kong must have occupied the opposite seat');
  assert.equal(result.aria, 'N · Chow!');
  const first = result.samples[0];
  assert(first.visible, 'the new callout is immediately visible, not deferred to hide a placement flash');
  assert(Math.abs(first.x - result.ownerRight - 8) <= 1,
    `the FIRST visible Chow must be beside seat 3, not at the previous seat: ${JSON.stringify(result)}`);
  for (const sample of result.samples) {
    assert(sample.visible);
    assert.equal(sample.text, 'Chow!');
    assert.equal(sample.reduced, 'true');
    assert.equal(sample.animations, 0);
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(sample[key] - first[key]) <= 1, `${key} must stay static`);
  }
});

test('the existing claim overlay and action gate honor the full authoritative eight-second deadline beyond five seconds', () => {
  let now = 10_000;
  const DateClock = class extends Date { static now() { return now; } };
  const loader = sourceLoader({
    Date: DateClock, window: { setInterval: () => 1, clearInterval() {}, setTimeout() {} },
  }, { 'i18n.ts': { t: key => key, onLanguageChange() {} }, 'toast.ts': { showToast() {} } });
  const { ClaimWindowOverlay } = loader.load('ui/claim-window-overlay.ts');
  const { RuleActionControls } = loader.load('ui/rule-action-controls.ts');
  const claim = { gameId: 'clock-room', stateVersion: 1, available: ['Pung'], deadline: now + 8000, source: 1, tile: 4 };
  const controller = Object.assign(Object.create(RuleActionControls.prototype), {
    pending: null, awaitingSnapshot: false, actor: 'owner', claimSnapshot: claim, ownerContext: () => 'owner',
    client: { turn: { get: () => ({ phase: 'AwaitingClaim' }) } },
  });
  assert.equal(controller.claim, claim);
  const root = new Label(), timer = new Label(), progress = new Label();
  const overlay = Object.assign(new ClaimWindowOverlay({}), {
    root, activeClaim: claim, tileEl: { querySelector: () => null }, passBtn: new Label(),
    timerEl: timer, progressEl: progress, badges: { Pung: new Label() },
  });
  overlay.refresh();
  assert.equal(timer.textContent, '8.0');
  assert.equal(progress.style.width, '100.0%');
  now += 5001; overlay.tick();
  assert.equal(controller.claim, claim, 'the shared action controller still allows the remaining claim window');
  assert.equal(timer.textContent, '3.0');
  assert.equal(root.hidden, false);
  assert.equal(overlay.badges.Pung.disabled, false);
  now = claim.deadline;
  assert.equal(controller.claim, null);
  overlay.tick();
  assert.equal(timer.textContent, '0.0');
});
