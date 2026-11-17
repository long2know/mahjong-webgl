import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { actualRoomReady, fixtureTarget } from './browser-ux.mjs';
import { gameHarness, plain } from '../../src/frontend/autotable-src/tests/node/renderer-test-support.mjs';

function fixture(t) {
  const h = gameHarness();
  t.after(h.close);
  h.join();
  h.snapshot([]);
  const frame = plain(h.adapter.latest), room = frame.session.gameId;
  assert.equal(frame.session.snapshotReady, true);
  const game = { adapter: { latest: frame },
    renderer: { state: 'ready', scene: { committed: { frame } } } };
  Object.defineProperty(game, 'gameId', { get() { throw Error('Game.gameId is not the observed room contract'); } });
  const window = { location: new URL(`http://127.0.0.1:5098/?gameId=${encodeURIComponent(room)}`), game };
  const ready = () => runInNewContext(`(${actualRoomReady.toString()})(${JSON.stringify(room)})`, { window, URL });
  return { window, game, frame, ready };
}

test('real room wait safely polls absent bootstrap and old frames during navigation', t => {
  assert.equal(fixtureTarget('http://127.0.0.1:5099').origin, 'http://127.0.0.1:5099');
  for (const unsafe of ['http://127.0.0.1:5086', 'http://127.0.0.1:5100', 'http://localhost:5099',
    'https://127.0.0.1:5099', 'http://127.0.0.1:5099/?gameId=existing']) {
    assert.throws(() => fixtureTarget(unsafe), assert.AssertionError);
  }
  const h = fixture(t);
  h.window.game = undefined;
  assert.equal(h.ready(), false, 'a page replacement must be polled, not throw before window.game exists');
  h.window.game = {};
  assert.equal(h.ready(), false);
  h.window.game = h.game;
  h.window.location.searchParams.set('gameId', 'next-room');
  assert.equal(h.ready(), false, 'an old ready frame must not qualify a newly navigating URL');
});

test('real room wait requires the URL, actual adapter session and GPU-committed room to agree', t => {
  const h = fixture(t);
  assert.equal(h.ready(), true, 'the actual projected frame must qualify without any Game.gameId property');
  h.game.adapter.latest = undefined;
  assert.equal(h.ready(), false);
  h.game.adapter.latest = h.frame;
  h.game.renderer.scene.committed = undefined;
  assert.equal(h.ready(), false, 'adapter readiness alone is not rendered-room evidence');
  h.game.renderer.scene.committed = { frame: { ...h.frame, session: { ...h.frame.session, gameId: 'old-room' } } };
  assert.equal(h.ready(), false);
  h.game.renderer.scene.committed = { frame: h.frame };
  assert.equal(h.ready(), true);
});
