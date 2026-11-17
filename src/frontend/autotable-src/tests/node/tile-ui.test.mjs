import test from 'node:test';
import assert from 'node:assert/strict';
import { tileUiFixture } from './tile-ui-test-support.mjs';
import { plain } from './renderer-test-support.mjs';

const group = (kind, tileIds, exposed = false) => ({ kind, tileIds, exposed });
const result = groups => ({
  type: 'Hu', winner: 1, score: [], nextBanker: 1, hand: groups.flatMap(group => group.tileIds), handGroups: groups,
});
const owned = ids => ids.map(id => [String(id), { slotName: `hand.${id}@0`, face: Math.floor(id / 4) }]);
const claim = overrides => ({ gameId: 'runtime-room', stateVersion: 7, available: ['Pung', 'Kong'], source: 2, tile: 43, ...overrides });
const key = (window, value) => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key: value, ctrlKey: false, altKey: false, metaKey: false });
  window.dispatchEvent(event); return event;
};

test('licensed DOM tile faces keep full localized names, correct suit boundaries and an explicit artwork-error fallback', () => {
  const f = tileUiFixture(), { createPhysicalTileFace } = f.load('ui/tile-face.ts');
  for (const [locale, suits, separator] of [
    ['en', ['characters', 'circles', 'bamboo'], ' '],
    ['zh-Hans', ['万', '筒', '条'], ''], ['zh-Hant', ['萬', '筒', '條'], ''],
  ]) {
    f.language(locale);
    for (const id of [0, 35, 36, 71, 72, 107]) {
      const tile = createPhysicalTileFace(id), face = Math.floor(id / 4), image = tile.querySelector('img');
      assert.equal(tile.getAttribute('aria-label'), `${face % 9 + 1}${separator}${suits[Math.floor(face / 9)]}`);
      assert.match(image.src, /Faces(?:Labelled)?\.png$/);
      assert.equal(tile.dataset.art, 'loading');
      assert(tile.querySelector('.mahjong-tile-fallback').textContent.length > 0);
      image.dispatchEvent(new Event('load'));
      assert.equal(tile.dataset.art, 'ready');
    }
  }
  f.language('en');
  const failed = createPhysicalTileFace(40);
  failed.querySelector('img').dispatchEvent(new Event('error'));
  assert.equal(failed.dataset.art, 'unavailable');
  assert.match(failed.getAttribute('aria-label'), /2 circles.*Artwork unavailable/);
  assert.equal(failed.querySelector('.mahjong-tile-fallback').textContent, '2 circles');
  for (const id of [null, 'h_hidden', '40', -1, 108, NaN]) {
    const tile = createPhysicalTileFace(id);
    assert.equal(tile.querySelector('img'), null);
    assert.equal(tile.dataset.face, undefined);
    assert.equal(tile.getAttribute('aria-label'), 'Unknown tile');
  }
});

test('server grouping renders every Kong exposure, seven pairs with four identical copies, and truthful special residuals without assuming14tiles', () => {
  const f = tileUiFixture(), { renderResultTiles } = f.load('ui/result-hand.ts');
  for (const [kind, exposed] of [['concealedKong', false], ['exposedKong', true], ['addedKong', true]]) {
    const value = result([group(kind, [8, 9, 10, 11], exposed), group('chow', [36, 40, 44]),
      group('chow', [48, 52, 56]), group('chow', [72, 76, 80]), group('pair', [16, 17])]);
    const node = f.node('result-hand'); renderResultTiles(node, value.hand, value);
    assert.equal(node.dataset.grouped, 'true'); assert.equal(node.querySelectorAll('.result-tile').length, 15);
    const kong = node.querySelectorAll('.result-tile-group')[0];
    assert.equal(kong.dataset.exposed, String(exposed));
    assert.equal(kong.querySelectorAll('img').length, 4, 'concealed during play does not hide an already revealed result');
  }
  const pairs = result([[4, 5], [6, 7], [8, 9], [12, 13], [16, 17], [20, 21], [24, 25]].map(ids => group('pair', ids)));
  renderResultTiles(f.node('result-hand'), pairs.hand, pairs);
  assert.equal(f.node('result-hand').querySelectorAll('.result-tile-group').length, 7);
  const special = result([group('special', [0, 32, 36, 68, 72, 104, 1, 33, 37, 69, 73, 105, 2, 34])]);
  renderResultTiles(f.node('result-hand'), special.hand, special);
  const specialGroups = f.node('result-hand').querySelectorAll('.result-tile-group');
  assert.equal(specialGroups.length, 1); assert.equal(specialGroups[0].dataset.kind, 'special');
  assert.equal(specialGroups[0].querySelectorAll('.result-tile').length, special.hand.length);
});

test('invalid or absent server grouping falls back to flat graphics in original order and never fabricates a winning-tile highlight', () => {
  const f = tileUiFixture(), { renderResultTiles } = f.load('ui/result-hand.ts'), node = f.node('result-hand');
  const hand = [2, 0, 1, 16, 17];
  for (const groups of [undefined, [], [group('madeUp', hand)], [group('pung', [0, 1, 2])],
    [group('pung', [0, 1, 2]), group('pair', [16, 16])], [group('pung', [0, 1, 2]), group('pair', [16, 108])],
    [group('pung', [0, 1, 2]), { kind: 'pair', tileIds: [16, 17] }]]) {
    renderResultTiles(node, hand, { ...result([]), hand, handGroups: groups });
    assert.equal(node.dataset.grouped, 'false');
    assert.deepEqual(node.querySelectorAll('.result-tile').map(tile => Number(tile.dataset.tileId)), hand);
    assert.equal(node.querySelectorAll('[data-winning="true"]').length, 0);
    assert.match(node.querySelector('.result-groups-unavailable').textContent, /server order/);
  }
  const value = { ...result([group('pung', [0, 1, 2]), group('pair', [16, 17])]), winResult: { winningTileId: 17 } };
  renderResultTiles(node, value.hand, value);
  assert.equal(node.querySelectorAll('[data-winning="true"]').length, 1);
  assert.equal(node.querySelector('[data-winning="true"]').dataset.tileId, '17');
  for (const winningTileId of [undefined, 108, 16.5, '17']) {
    renderResultTiles(node, value.hand, { ...value, winResult: { winningTileId } });
    assert.equal(node.querySelectorAll('[data-winning="true"]').length, 0);
  }
  const duplicate = [...value.hand, 17];
  renderResultTiles(node, duplicate, { ...value, hand: duplicate });
  assert.equal(node.querySelectorAll('[data-winning="true"]').length, 0, 'ambiguous repeated legacy physical IDs cannot select a winning copy');
  renderResultTiles(node, [], { ...value, type: 'Draw', hand: [] });
  assert.equal(node.children.length, 0);
});

test('claim previews use the exact lowest matching own partners or offered Chow option, never opponents or hidden handles', () => {
  const f = tileUiFixture({ things: [...owned([40, 41, 42, 36, 48]),
    ['h_foreign', { slotName: 'hand.0@0', face: 10 }], ['39', { slotName: 'hand.0@2', face: 10 }],
    ['38', { slotName: 'meld.0.0@0', face: 10 }]] });
  const { claimPreview } = f.load('ui/claim-preview.ts');
  assert.deepEqual(plain(claimPreview(f.client, claim(), 'Pung')).filter(tile => tile.origin === 'own').map(tile => tile.tileId), [40, 41]);
  assert.deepEqual(plain(claimPreview(f.client, claim(), 'Kong')).filter(tile => tile.origin === 'own').map(tile => tile.tileId), [40, 41, 42]);
  const chow = claim({ available: ['Chow'], tile: 44, chowOptions: [[40, 48]] });
  assert.deepEqual(plain(claimPreview(f.client, chow, 'Chow')).map(tile => tile.tileId), [40, 44, 48]);
  assert.equal(claimPreview(f.client, { ...chow, chowOptions: [[40, 39]] }, 'Chow'), null);
  assert.equal(claimPreview(f.client, { ...chow, chowOptions: [[36, 40], [40, 48]] }, 'Chow'), null);
  f.client.things.data.set('41', { slotName: 'hand.41@0', face: null });
  f.client.things.data.set('42', { slotName: 'hand.42@0', face: null });
  assert.equal(claimPreview(f.client, claim(), 'Pung'), null, 'explicit entitlement strips beat numeric physical IDs');
});

test('actual claim overlay shows current offered artwork and source nick/wind, hides irrelevant choices and keeps deadline/Pass guards', () => {
  const f = tileUiFixture({ claim: claim(), things: owned([40, 41, 42]) });
  const { ClaimWindowOverlay } = f.load('ui/claim-window-overlay.ts'), overlay = new ClaimWindowOverlay({ client: f.client });
  overlay.attach();
  const root = f.node('claim-window-actions');
  assert.equal(root.hidden, false);
  assert.equal(root.querySelector('.ferro-claim-tile-source').textContent, 'Jade Otter · West');
  assert.equal(root.querySelector('.claim-offered-face').getAttribute('aria-label'), '2 circles');
  assert.equal(root.querySelector('.claim-offered-face').dataset.tileId, '43');
  assert.equal(root.querySelector('.ferro-claim-timer-value').textContent, '8.0');
  assert.equal(overlay.badges.Chow.hidden, true); assert.equal(overlay.badges.Hu.hidden, true);
  assert.equal(overlay.previews.Pung.querySelectorAll('.mahjong-tile').length, 3);
  assert.equal(overlay.previews.Kong.querySelectorAll('.mahjong-tile').length, 4);
  assert.equal(overlay.previews.Kong.querySelectorAll('[data-origin="discard"]').length, 1);
  assert.equal(f.client.sent.length, 0);
  f.advance(5100);
  assert.equal(root.hidden, false); assert.equal(root.querySelector('.ferro-claim-timer-value').textContent, '2.9');
  key(f.window, 'p'); assert.equal(f.client.sent.length, 0, 'camera P never becomes Pung');
  key(f.window, 'Escape');
  assert.deepEqual(plain(f.client.sent), [[['claim', '0', { action: 'pass', type: null, gameId: 'runtime-room', expectedVersion: 7 }]]]);
  key(f.window, 'Escape'); assert.equal(f.client.sent.length, 1);
  assert.equal(root.hidden, true);
  assert.equal(root.querySelectorAll('.claim-preview-tile').length, 0);
  overlay.detach();
});

test('actual multi-Chow chooser paints exact public/own combinations, sends only the selected legal payload and rejects stale/expired clicks', () => {
  const metadata = claim({ available: ['Chow'], tile: 44, chowOptions: [[36, 40], [40, 48]] });
  const f = tileUiFixture({ claim: metadata, things: owned([36, 40, 48]) });
  const { ClaimWindowOverlay } = f.load('ui/claim-window-overlay.ts'), overlay = new ClaimWindowOverlay({ client: f.client });
  overlay.attach();
  assert.match(overlay.previewNotes.Chow.textContent, /2 combinations/);
  key(f.window, 'c');
  assert.equal(f.client.sent.length, 0, 'opening a choice never commits an arbitrary pair');
  const dialog = f.node('rule-action-choice-dialog'), buttons = f.node('rule-action-choices').querySelectorAll('button');
  assert.equal(dialog.open, true); assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map(button => button.querySelectorAll('.claim-preview-tile').map(tile => Number(tile.dataset.tileId))),
    [[36, 40, 44], [40, 44, 48]]);
  assert(buttons.every(button => button.querySelectorAll('[data-origin="discard"]').length === 1));
  const old = buttons[0];
  buttons[1].click();
  assert.deepEqual(plain(f.client.sent), [[['claim', '0', {
    action: 'claim', type: 'Chow', tileIds: [40, 48], gameId: 'runtime-room', expectedVersion: 7,
  }]]]);
  old.click(); assert.equal(f.client.sent.length, 1);
  f.receive([['claim', '0', null]]);
  f.receive([['claim', '0', { ...metadata, stateVersion: 8, deadline: f.time() + 8000 }]]);
  key(f.window, 'c');
  const expired = f.node('rule-action-choices').querySelectorAll('button')[0];
  f.advance(8001);
  assert.equal(dialog.open, false); assert.equal(f.node('claim-window-actions').hidden, true);
  expired.click(); assert.equal(f.client.sent.length, 1);
  overlay.detach();
});
