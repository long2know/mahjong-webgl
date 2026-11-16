import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sourceLoader } from './renderer-test-support.mjs';
import { TileElement } from './tile-ui-test-support.mjs';

function fixture(mode = 'changsha') {
  const document = { body: new TileElement('body'), createElement: tag => new TileElement(tag) };
  document.getElementById = id => document.body.querySelector(`#${id}`);
  const client = {
    connectionMode: mode, seatPlayers: ['human', 'bot-one', 'bot-two', 'bot-three'], nicks: { get: () => null },
    ...Object.fromEntries(['match', 'dice', 'sound', 'things', 'claim', 'pickup', 'result'].map(key => [key, new EventEmitter()])),
  };
  const { MoveLog } = sourceLoader({ document, requestAnimationFrame: callback => { callback(); return 1; } }).load('move-log.ts');
  const log = new MoveLog(client); log.start();
  return {
    client,
    things: entries => client.things.emit('update', entries, false),
    claim: tile => client.claim.emit('update', [['0', { available: ['Chow'], tile, source: 2 }]], false),
    actions: () => document.body.querySelectorAll('.move-log-action').map(node => node.textContent.trim()),
  };
}

test('current physical claim6 and its explicit Things face1 agree with the accepted2万 offer instead of modulo27', () => {
  const f = fixture();
  f.things([[6, { slotName: 'discard.0.0@2', face: 1 }]]);
  f.claim(6);
  assert.deepEqual(f.actions(), ['discarded 2万', 'claim window — Chow on 2万 (from Seat 2)']);
});

test('Things explicit logical faces are not divided; missing faces and physical claim IDs use the existing normalizer across suits', () => {
  const f = fixture();
  f.things([['24', { slotName: 'discard.0.0@1', face: 6 }]]);
  f.things([['40', { slotName: 'discard.0.0@2' }]]);
  f.things([[6, { slotName: 'meld.0.0@3' }]]);
  f.claim(40); f.claim(80); f.claim(107);
  assert.deepEqual(f.actions(), [
    'discarded 7万', 'discarded 2筒', 'formed a meld with 2万',
    'claim window — Chow on 2筒 (from Seat 2)',
    'claim window — Chow on 3条 (from Seat 2)',
    'claim window — Chow on 9条 (from Seat 2)',
  ]);
});

test('opaque and explicitly masked faces stay unknown while relay logical-face formatting is preserved', () => {
  const f = fixture();
  f.things([['h_private', { slotName: 'discard.0.0@2', face: 6 }]]);
  assert.deepEqual(f.actions(), []);
  f.things([[6, { slotName: 'discard.0.0@2', face: null }], [8, { slotName: 'meld.0.0@3', face: null }]]);
  f.claim('h_private'); f.claim(108);
  assert.deepEqual(f.actions(), [
    'discarded ?', 'formed a meld with ?', 'claim window — Chow on ? (from Seat 2)', 'claim window — Chow on ? (from Seat 2)',
  ]);
  const relay = fixture('relay');
  relay.things([[6, { slotName: 'discard.0.0@2' }], [24, { slotName: 'discard.0.1@2', face: 6 }]]);
  relay.claim(6);
  assert.deepEqual(relay.actions(), ['discarded 7万', 'discarded 7万', 'claim window — Chow on 7万 (from Seat 2)']);
  relay.things([[8, { slotName: 'discard.0.2@2', face: null }]]);
  assert.equal(relay.actions().at(-1), 'discarded ?');
});
