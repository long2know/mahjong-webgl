import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const help = `Usage: node tests/migration/browser-ux.mjs http://127.0.0.1:5097|5098 [--capture]
  [--setup-only] [--baseline artifacts/<before>/browser/setup.json]
  [--manual-receipt artifacts/<canonical-manual>/browser/receipt.json]

Default: qualification, requiring an actual BEFORE setup capture.
--capture records observations, never a passing integration verdict. No authority is injected.
--setup-only is capture-only: exercise the real setup and submission without repeating game orbits.
Output: artifacts/$MAHJONG_ARTIFACT_NAME/browser/ (a new directory is required).
Chrome inherits the caller's profile/temp environment; this script does not change it.

The final Frontend binding observes scene.committed.cue/discardId and actual public labels.
It never reconstructs an animation, guesses concealed tile identities, or alters authority.
Setup uses #lobby-toggle (not a duplicated/hidden "Lobby" text span), #ferro-variant-select,
#lobby-advanced > summary, and #lobby-apply. It records all creation controls/constraints,
saved defaults restored at a clean entry, and the actual navigation submission. Only
this run's initial/generated room names are normalized when comparing BEFORE and AFTER.
Qualification also proves that an OPEN setup's different variant remains a draft until Start.

Manual pickup reuses the already-run browser-webgl.mjs manual receipt (no duplicate run).
Human+3-bot and 4-bot spectator scenarios use the retained seeded creation route,
never an injected game state.
This harness records browser emulation/software-GPU evidence, not physical-device performance.
`;

const root = process.cwd();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Installed before the application. Wrappers are exactly-once pass-through observations.
function installUxProbe() {
  const capacity = 3600;
  const probe = window.__ux = { publications: [], moves: [], frames: [], actions: [], results: [],
    errors: [], dropped: 0, timeOrigin: performance.timeOrigin };
  let game, previous = null;
  const add = (field, value) => {
    if (probe[field].length === capacity) { probe.dropped++; return; }
    probe[field].push(value);
  };
  const privacy = frame => {
    for (const entity of frame.entities) {
      if ((entity.group === 'wall' || entity.group === 'hand' && entity.seat !== frame.session.actorSeat)
        && (entity.appearance.faceIndex !== null || entity.appearance.showFace !== false)) {
        add('errors', `Hidden-face entitlement violation: ${entity.entityId} (${entity.group})`);
      }
    }
  };
  const identity = frame => ({ sessionId: frame.sessionId, frameId: frame.frameId,
    layoutRevision: frame.layoutRevision });
  const turn = frame => ({ activeSeat: frame.turn?.activeSeat, phase: frame.turn?.phase,
    awaitingDiscard: frame.turn?.awaitingDiscard, actorSeat: frame.session.actorSeat,
    handCount: frame.localHand.entityIds.length });
  Object.defineProperty(window, 'game', {
    configurable: true, get: () => game,
    set(value) {
      game = value;
      const publish = value.renderer.publish;
      value.renderer.publish = function (layout, frame) {
        try {
          privacy(frame);
          const at = performance.now();
          add('publications', { at, ...identity(frame), ...turn(frame) });
          if (previous?.sessionId === frame.sessionId) {
            for (const entity of frame.entities) {
              const from = previous.entities.get(entity.entityId);
              if (from?.slotName === entity.slotName && from?.group === entity.group) continue;
              const kind = entity.group === 'discard' && from?.group !== 'discard' ? 'discard'
                : entity.group === 'meld' && from?.group !== 'meld' ? 'meld' : 'relocate';
              if (!from && kind === 'relocate') continue;
              add('moves', { at, ...identity(frame), kind, entityId: entity.entityId, seat: entity.seat,
                from: { group: from?.group ?? null, slotName: from?.slotName ?? null },
                to: { group: entity.group, slotName: entity.slotName } });
            }
            // Public count outcomes are independent evidence. Do not correlate retired
            // concealed handles with the newly entitled physical IDs of an opponent.
            for (const seat of [0, 1, 2, 3]) {
              const count = frame.entities.filter(entity => entity.group === 'hand' && entity.seat === seat).length;
              if (count === previous.counts[seat] + 1) add('moves', {
                at, ...identity(frame), kind: 'draw', entityId: null, seat,
                beforeCount: previous.counts[seat], afterCount: count,
                from: { group: null, slotName: null }, to: { group: 'hand', slotName: null },
              });
            }
          }
          previous = { sessionId: frame.sessionId,
            counts: [0, 1, 2, 3].map(seat =>
              frame.entities.filter(entity => entity.group === 'hand' && entity.seat === seat).length),
            entities: new Map(frame.entities.map(entity => [entity.entityId,
              { group: entity.group, slotName: entity.slotName }])) };
        } catch (error) { add('errors', error.message); }
        return Reflect.apply(publish, this, [layout, frame]);
      };
    },
  });
  window.addEventListener('mahjong:renderer-frame', event => {
    try {
      const host = game?.renderer, scene = host?.scene, commit = scene?.committed;
      if (!commit?.frame.session.snapshotReady) return;
      const frame = commit.frame, receipt = event.detail.receipt;
      privacy(frame);
      if (receipt.frameId !== frame.frameId || receipt.sessionId !== frame.sessionId
        || receipt.layoutRevision !== frame.layoutRevision) {
        add('errors', 'GPU publication receipt did not identify the committed geometry');
      }
      const points = frame.entities.filter(entity => ['hand', 'discard', 'meld'].includes(entity.group))
        .map(entity => {
          const point = scene.project(entity.entityId);
          return { entityId: entity.entityId, group: entity.group, seat: entity.seat,
            slotName: entity.slotName, drawn: entity.display?.drawn === true,
            x: point?.x ?? null, y: point?.y ?? null };
        });
      add('frames', { at: performance.now(), ...identity(frame), ...turn(frame),
        resizeRevision: commit.viewport.resizeRevision,
        viewport: { width: host.viewport.widthCssPx, height: host.viewport.heightCssPx },
        hand: commit.plan.hand ? { ...commit.plan.hand } : null,
        presentation: { ...frame.presentation }, points,
        cue: window.__uxReadPresentation ? window.__uxReadPresentation(scene) : null,
        publication: { receipt: { ...receipt }, lastRendered: host.lastRendered,
          inFlightFrameId: host.inFlight?.frame.frameId ?? null, queuedFrameId: host.queue?.frame.frameId ?? null } });
    } catch (error) { add('errors', error.message); }
  });
  window.addEventListener('mahjong:renderer-action', event => {
    const action = event.detail.action;
    add('actions', { at: performance.now(), actionId: action.actionId, kind: action.intent.kind,
      entityId: action.intent.entityId ?? null });
  });
  window.addEventListener('mahjong:renderer-action-result', event => {
    const result = event.detail.result;
    add('results', { actionId: result.actionId, status: result.status, reason: result.reason });
  });
}

function readPresentation(scene) {
  const commit = scene.committed, cue = commit.cue;
  return {
    latestDiscardEntityId: commit.discardId ?? null,
    latestAction: cue ? { kind: cue.kind, entityId: cue.entityId, seat: cue.seat,
      accentActive: !document.body.classList.contains('reduced-motion') } : null,
    publicLabels: [...document.querySelectorAll('.webgl-action,.webgl-seat')]
      .filter(node => !node.hidden && node.getClientRects().length).map(node => node.textContent),
    latestDiscardLabelVisible: !!document.querySelector('.webgl-latest:not([hidden])'),
  };
}

function assertTrace(trace) {
  assert.equal(trace.dropped, 0, 'Evidence capacity exhausted; do not silently discard the observed game');
  assert.deepEqual(trace.errors, [], 'Privacy, GPU correlation, or observation failure');
  assert(trace.frames.length > 0, 'No actual populated-game GPU publication was observed');
}

function movement(trace, move) {
  const next = trace.moves.find(value => value.at > move.at && value.entityId === move.entityId);
  return trace.frames.filter(frame => frame.at >= move.at && frame.at < Math.min(next?.at ?? Infinity, move.at + 900))
    .map(frame => ({ frame, point: frame.points.find(point => point.entityId === move.entityId
      && point.group === move.to.group) }))
    .filter(sample => Number.isFinite(sample.point?.x) && Number.isFinite(sample.point?.y));
}

function qualifyMovement(trace, move, reduced) {
  const samples = movement(trace, move);
  assert(samples.length >= 2, `Insufficient actual GPU samples for ${move.kind} ${move.entityId}`);
  const positions = new Set(samples.map(({ point }) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`));
  assert(samples.some(sample => sample.frame.cue?.publicLabels
    .some(label => new RegExp(`\\b${move.kind}\\b`, 'i').test(label))),
  'The actual public move must have a rendered, distinguishable action label');
  if (reduced) {
    assert.equal(positions.size, 1, 'Reduced motion must commit placement immediately without visible travel');
    assert(samples.every(sample => sample.frame.cue?.latestAction?.accentActive !== true),
      'Reduced motion must not pulse the latest-action accent');
  } else {
    assert(positions.size >= 3, 'A real public move must have onset/intermediate/settled committed positions, not snap');
    assert(samples.some(sample => sample.frame.cue?.latestAction?.kind === move.kind
      && sample.frame.cue.latestAction.seat === move.seat && sample.frame.cue.latestAction.accentActive === true),
    'The real public action must initially have its latest-action accent');
  }
  return { move, committedSamples: samples.length, distinctPositions: positions.size,
    observedWindowMilliseconds: samples.at(-1).frame.at - samples[0].frame.at };
}

function qualifyHandFraming(trace) {
  const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const pitches = { 13: [], 14: [] };
  for (const frame of trace.frames) {
    if (frame.presentation.handLayout !== 'separate' || !(frame.handCount in pitches)) continue;
    const changed = trace.moves.findLast(move => move.at <= frame.at && move.seat === frame.actorSeat
      && (move.from.group === 'hand' || move.to.group === 'hand'));
    if (!changed || frame.at - changed.at < 350) continue;
    const xs = frame.points.filter(point => point.group === 'hand' && point.seat === frame.actorSeat
      && !point.drawn && Number.isFinite(point.x)).map(point => point.x).sort((a, b) => a - b);
    const distances = xs.slice(1).map((x, index) => x - xs[index]).filter(distance => distance > .5);
    if (distances.length >= 10) pitches[frame.handCount].push(median(distances));
  }
  assert(pitches[13].length && pitches[14].length, 'Stable hand framing needs settled real 13- AND 14-tile hands');
  const thirteen = median(pitches[13]), fourteen = median(pitches[14]);
  assert(Math.abs(thirteen / fourteen - 1) <= .03,
    `The separate hand must not rescale on draw/discard (${thirteen}px versus ${fourteen}px tile pitch)`);
  return { thirteenTilePitchCssPx: thirteen, fourteenTilePitchCssPx: fourteen,
    settledSamples: { thirteen: pitches[13].length, fourteen: pitches[14].length } };
}

export function actualRoomReady(room) {
  const game = window.game, latest = game?.adapter?.latest;
  const committed = game?.renderer?.scene?.committed?.frame;
  return typeof room === 'string' && room.length > 0
    && new URL(window.location.href).searchParams.get('gameId') === room
    && latest?.session?.gameId === room && latest?.session?.snapshotReady === true
    && game?.renderer?.state === 'ready'
    && committed?.session?.gameId === room && committed?.session?.snapshotReady === true;
}

async function main() {
  if (process.argv.includes('--help')) { console.log(help); return; }
  const args = process.argv.slice(2), target = new URL(args.shift());
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1', 'Only an explicitly isolated loopback fixture is allowed');
  assert(['5097', '5098'].includes(target.port), 'Only assigned BEFORE/AFTER fixture ports 5097/5098 are allowed; never 5086');
  assert.equal(target.pathname, '/');
  assert.equal(target.search + target.hash + target.username + target.password, '');
  const capture = args.includes('--capture');
  const option = name => {
    const at = args.indexOf(name);
    if (at < 0) return null;
    assert(args[at + 1] && !args[at + 1].startsWith('--'), `Missing ${name} value`);
    return args[at + 1];
  };
  const setupOnly = args.includes('--setup-only');
  assert(!setupOnly || capture, '--setup-only is capture-only, never a partial passing qualification');
  const known = new Set(['--capture', '--setup-only', '--baseline', '--manual-receipt']);
  for (let index = 0; index < args.length; index++) {
    assert(known.has(args[index]), `Unknown option: ${args[index]}`);
    if (!['--capture', '--setup-only'].includes(args[index])) index++;
  }
  const baselineName = option('--baseline');
  const manualName = option('--manual-receipt')
    ?? `artifacts/ux-${target.port === '5097' ? 'before' : 'after'}-manual/browser/receipt.json`;
  let baseline = null;
  if (baselineName) {
    const file = fs.realpathSync(path.resolve(root, baselineName));
    assert(file.startsWith(path.join(root, 'artifacts') + path.sep) && file.endsWith('.json'));
    baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(baseline.artifactKind, 'mahjong-ux-actual-setup');
    assert.equal(baseline.status, 'captured');
    assert.equal(baseline.target, 'http://127.0.0.1:5097', 'Setup baseline must come from the isolated BEFORE runtime');
  }
  if (!capture) {
    assert(baseline, 'An actual BEFORE setup.json is required; run --capture --setup-only on 5097 first');
  }
  const artifactName = process.env.MAHJONG_ARTIFACT_NAME ?? `ux-${capture ? 'capture' : 'qualification'}-${Date.now()}`;
  assert.match(artifactName, /^[a-z0-9-]+$/);
  const output = path.join(root, 'artifacts', artifactName, 'browser');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  fs.mkdirSync(path.join(output, 'screenshots'));
  const receipt = { artifactKind: 'mahjong-ux-browser', status: 'running', approval: 'not-issued',
    mode: capture ? 'capture-only' : 'qualification', target: target.origin, cases: [], requests: [], errors: [],
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    harnessSha256: hash(fs.readFileSync(new URL(import.meta.url))),
    qualification: 'Actual seeded games and GPU-fence-correlated geometry; headless Chrome/software GPU and touch emulation, not physical-device performance.',
    unqualified: setupOnly ? ['Setup-only capture: no gameplay or integration approval.'] : [] };
  const require = createRequire(path.join(root, 'src/frontend/autotable-src/package.json'));
  const { chromium } = require('@playwright/test');
  let browser;
  const runId = `ux-test-${Date.now()}-${process.pid}`;
  const traces = new Map();
  try {
    const manifestResponse = await fetch(new URL('web-build.json', target), { redirect: 'error' });
    assert.equal(manifestResponse.status, 200);
    const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer()), manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.engine, 'webgl2');
    assert.equal(manifest.artifactKind, 'mahjong-web-build');
    receipt.application = { sourceRevision: manifest.sourceRevision, manifestSha256: hash(manifestBytes) };
    if (!capture && target.port === '5098') assert.notEqual(receipt.application.manifestSha256,
      baseline.application.manifestSha256, 'AFTER qualification cannot silently compare the BEFORE build to itself');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    receipt.browserVersion = browser.version();

    async function newGame(name, viewport, { reduced = false, touch = true, spectator = false } = {}) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: touch ? 2 : 1,
        isMobile: touch, hasTouch: touch, locale: 'en-US',
        reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
      await context.addInitScript({ content: `window.__uxReadPresentation = (${readPresentation.toString()});` });
      await context.addInitScript(installUxProbe);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== target.origin) {
          receipt.errors.push(`External request blocked: ${url.origin}${url.pathname}`);
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage(), wire = [];
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => receipt.errors.push(`${name}: ${error.message}`));
      page.on('request', request => receipt.requests.push({ case: name,
        origin: new URL(request.url()).origin, path: new URL(request.url()).pathname,
        method: request.method(), navigation: request.isNavigationRequest() }));
      page.on('websocket', socket => {
        assert.equal(new URL(socket.url()).host, target.host);
        socket.on('framesent', frame => {
          for (const fragment of String(frame.payload).split('\u001e').filter(Boolean)) {
            try {
              const value = JSON.parse(fragment);
              for (const entry of value.entries ?? []) if (['discard', 'pickup'].includes(entry[0])) wire.push(entry);
            } catch {}
          }
        });
      });
      const room = `${runId}-${name}`;
      await page.goto(`${target.origin}/?${new URLSearchParams({ gameId: room, createGame: room,
        variant: 'changsha', seat: spectator ? '-1' : '0', botCount: spectator ? '4' : '3',
        dealMode: 'auto', seed: '20261010' })}`,
      { waitUntil: 'domcontentloaded' });
      for (const selector of ['#onboarding-skip', '#tour-skip']) {
        const skip = page.locator(selector);
        if (await skip.isVisible()) await skip.click();
      }
      await page.waitForFunction(actualRoomReady, room, { timeout: 60000 });
      await page.waitForFunction(() => (window.game?.renderer?.scene?.committed?.frame.entities.length ?? 0) > 50);
      for (const selector of ['#onboarding-skip', '#tour-skip']) {
        const skip = page.locator(selector);
        if (await skip.isVisible()) await skip.click();
      }
      assert.equal(await page.evaluate(() => window.game.renderer.engine), 'webgl2');
      assert.equal(await page.evaluate(() => typeof window.MahjongUnityBridge), 'undefined');
      assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), reduced);
      const value = { page, context, name, wire, touch, reduced };
      traces.set(name, value);
      return value;
    }

    async function snapshot(test, name) {
      const trace = await test.page.evaluate(() => window.__ux);
      assertTrace(trace);
      const state = await test.page.evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport.width,
          visualHeight: visualViewport.height, offsetTop: visualViewport.offsetTop },
        documentWidth: document.documentElement.scrollWidth,
        renderer: { engine: window.game.renderer.engine, state: window.game.renderer.state },
        committed: window.__ux.frames.at(-1),
      }));
      assert(state.documentWidth <= state.viewport.width + 1, 'The viewport must not overflow horizontally');
      await test.page.screenshot({ path: path.join(output, 'screenshots', `${name}.png`) });
      write(path.join(output, `${name}.json`), state);
      return state;
    }

    async function ownTurn(test, deadline) {
      while (Date.now() < deadline) {
        const state = await test.page.evaluate(() => ({
          ready: window.game.adapter.latest?.entities.some(entity => entity.interaction.canDiscard
            && window.game.renderer.scene.committed?.frame.entities.some(committed =>
              committed.entityId === entity.entityId && committed.interaction.canDiscard)),
          pass: !!document.querySelector('.ferro-claim-pass:not(:disabled)')?.getClientRects().length,
          failed: window.game.renderer.state !== 'ready',
        }));
        assert.equal(state.failed, false, 'Renderer became unavailable during the real game');
        if (state.pass) await test.page.locator('.ferro-claim-pass').click();
        else if (state.ready) return;
        await sleep(80);
      }
      throw Error('Seeded game did not produce the required turn orbits before the bounded deadline');
    }

    async function discard(test) {
      const tile = await test.page.evaluate(() => {
        const scene = window.game.renderer.scene;
        const entity = scene.committed.frame.entities.find(entity => entity.interaction.canDiscard && entity.appearance.showFace);
        return entity && { entityId: entity.entityId, ...scene.project(entity.entityId) };
      });
      assert(tile, 'No entitled, actually committed discard target');
      const box = await test.page.locator('#webgl-canvas').boundingBox();
      const at = { x: box.x + tile.x, y: box.y + tile.y };
      assert.equal(await test.page.evaluate(at => document.elementFromPoint(at.x, at.y)?.id, at), 'webgl-canvas');
      const wireBefore = test.wire.filter(entry => entry[0] === 'discard').length;
      const actionsBefore = await test.page.evaluate(() => window.__ux.actions.length);
      if (test.touch) await test.page.touchscreen.tap(at.x, at.y);
      else await test.page.mouse.dblclick(at.x, at.y, { delay: 20 });
      await test.page.waitForFunction(id => !window.game.adapter.latest.localHand.entityIds.includes(id), tile.entityId);
      await test.page.waitForFunction(({ start, id }) => window.__ux.actions.slice(start)
        .some(action => action.kind === 'discard' && action.entityId === id), { start: actionsBefore, id: tile.entityId });
      assert.equal(test.wire.filter(entry => entry[0] === 'discard').length, wireBefore + 1,
        'One physical gesture must submit exactly one real discard command');
      const actions = await test.page.evaluate(start => window.__ux.actions.slice(start), actionsBefore);
      const submitted = actions.filter(action => action.kind === 'discard');
      assert.equal(submitted.length, 1);
      await test.page.waitForFunction(id => window.__ux.results.some(result => result.actionId === id
        && result.status === 'submitted'), submitted[0].actionId);
    }

    async function screencast(test) {
      const cdp = await test.context.newCDPSession(test.page), frames = [];
      let bytes = 0, overflow = false, active = true;
      cdp.on('Page.screencastFrame', event => {
        const png = Buffer.from(event.data, 'base64');
        if (frames.length < 512 && bytes + png.length <= 128 * 1024 * 1024) {
          frames.push({ png, epochMilliseconds: event.metadata.timestamp * 1000 });
          bytes += png.length;
        } else overflow = true;
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => {
          if (active) receipt.errors.push(`Screencast acknowledgement: ${error.message}`);
        });
      });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      return async (trace, move) => {
        await cdp.send('Page.stopScreencast');
        active = false;
        await cdp.detach();
        assert.equal(overflow, false, 'Bounded screencast exhausted; no sequence evidence may be silently dropped');
        const samples = movement(trace, move);
        assert(samples.length >= 3, 'Sequence needs actual GPU onset/intermediate/settled samples');
        const draw = trace.moves.find(value => value.at > move.at && value.kind === 'draw');
        assert(draw, 'Latest-discard persistence needs an actual subsequent draw');
        const first = samples[0], last = samples.at(-1);
        const key = sample => `${sample.point.x.toFixed(2)},${sample.point.y.toFixed(2)}`;
        const settled = samples.find(sample => key(sample) === key(last)
          && sample.frame.at >= first.frame.at + 200);
        assert(settled, 'No settled committed sample before the next action');
        const between = samples.filter(sample => sample.frame.at < settled.frame.at
          && (test.reduced || key(sample) !== key(first) && key(sample) !== key(last)));
        const mid = between[Math.floor(between.length / 2)];
        const persistence = trace.frames.find(frame => frame.at >= draw.at && frame.at < draw.at + 300);
        assert(mid && persistence, 'Missing intermediate or next-draw GPU publication');
        const phases = { onset: first.frame, mid: mid.frame, settled: settled.frame, 'next-draw': persistence };
        const files = [];
        for (const [phase, frame] of Object.entries(phases)) {
          const nearest = frames.slice().sort((a, b) =>
            Math.abs(a.epochMilliseconds - trace.timeOrigin - frame.at)
            - Math.abs(b.epochMilliseconds - trace.timeOrigin - frame.at))[0];
          assert(nearest, 'No real screencast frames received');
          const delta = nearest.epochMilliseconds - trace.timeOrigin - frame.at;
          assert(Math.abs(delta) <= 150, `Screencast is too far from the ${phase} GPU sample (${delta}ms)`);
          const file = `${test.name}-${phase}.png`;
          fs.writeFileSync(path.join(output, 'screenshots', file), nearest.png);
          files.push({ phase, file, sha256: hash(nearest.png), gpuAt: frame.at, screenshotDeltaMilliseconds: delta,
            cue: frame.cue, receipt: frame.publication.receipt });
        }
        if (!capture && !test.reduced) {
          assert.equal(new Set(files.slice(0, 3).map(file => file.sha256)).size, 3,
            'Onset/intermediate/settled must be distinct actual screen frames');
        }
        return files;
      };
    }

    async function play(test, orbits, sequence = false) {
      const deadline = Date.now() + 90000;
      await ownTurn(test, deadline);
      const finishSequence = sequence ? await screencast(test) : null;
      let sequenceFiles = null, turns = [0, 0, 0, 0];
      for (let gestures = 0; gestures < 8 && turns.some(count => count < orbits); gestures++) {
        await discard(test);
        await ownTurn(test, deadline);
        // A real human decision pause lets the initial accent expire without holding authority.
        await test.page.waitForTimeout(900);
        const trace = await test.page.evaluate(() => window.__ux);
        assertTrace(trace);
        turns = [0, 1, 2, 3].map(seat => trace.moves.filter(move => move.kind === 'discard' && move.seat === seat).length);
        if (finishSequence && !sequenceFiles) {
          const draw = trace.moves.findLast(move => move.kind === 'draw' && move.seat === 0);
          const move = trace.moves.findLast(move => move.kind === 'discard' && move.seat !== 0 && move.at < draw?.at);
          assert(move, 'Need a real bot discard followed by the human draw, not a readiness screenshot');
          sequenceFiles = await finishSequence(trace, move);
          if (!capture) {
            const evidence = qualifyMovement(trace, move, test.reduced);
            const afterDraw = trace.frames.filter(frame => frame.at >= draw.at && frame.at <= draw.at + 700);
            assert(afterDraw.length > 0);
            assert(afterDraw.every(frame => frame.cue?.latestDiscardEntityId === move.entityId),
              'The actual latest-discard marker must survive the next draw');
            assert(afterDraw.some(frame => frame.cue?.latestAction?.kind === 'draw'
              && frame.cue.latestAction.seat === draw.seat
              && frame.cue.publicLabels.some(label => /\bdraw\b/i.test(label))),
            'A public draw must be visibly distinguished from the last discard');
            assert.notEqual(trace.frames.at(-1).cue?.latestAction?.accentActive, true,
              'The initial latest-action accent must settle instead of pulsing indefinitely');
            receipt.cases.push({ name: `${test.name}-motion-and-persistence`, ...evidence, sequenceFiles });
          }
        }
      }
      assert(turns.every(count => count >= orbits), `Need ${orbits} actual discard orbits across all seats; observed ${turns}`);
      const trace = await test.page.evaluate(() => window.__ux);
      assertTrace(trace);
      const framing = !capture && sequence ? qualifyHandFraming(trace) : null;
      const botDrawToDiscard = trace.moves.filter(move => move.kind === 'discard' && move.seat !== 0)
        .flatMap(move => {
          const draw = trace.moves.findLast(value => value.kind === 'draw' && value.seat === move.seat && value.at < move.at);
          if (!draw || trace.moves.some(value => value.kind === 'meld' && value.seat === move.seat
            && value.at > draw.at && value.at < move.at)) return [];
          return [{ seat: move.seat, drawAt: draw.at, discardAt: move.at,
            observedMilliseconds: move.at - draw.at }];
        });
      write(path.join(output, `${test.name}-trace.json`), { ...trace, submitted: test.wire });
      receipt.cases.push({ name: `${test.name}-actual-orbits`, discardsBySeat: turns, sequenceFiles,
        publicMoves: trace.moves.length, gpuPublications: trace.frames.length, framing, botDrawToDiscard,
        timingScope: 'Viewer-safe state publication arrival intervals; not server execution or physical-device performance.' });
    }

    if (!setupOnly) {
    const landscape = await newGame('landscape', { width: 844, height: 390 });
    await snapshot(landscape, 'neutral-844x390');
    await play(landscape, 2, true);
    await snapshot(landscape, 'landscape-progressed');
    for (const [name, viewport] of [
      ['rotation-portrait', { width: 390, height: 844 }],
      ['browser-chrome-contracted', { width: 844, height: 340 }],
      ['browser-chrome-expanded', { width: 844, height: 390 }],
    ]) {
      const revision = await landscape.page.evaluate(() => window.game.renderer.viewport.resizeRevision);
      await landscape.page.setViewportSize(viewport);
      await landscape.page.waitForFunction(revision => window.game.renderer.scene.committed?.viewport.resizeRevision > revision
        && window.game.renderer.scene.committed.viewport.resizeRevision === window.game.renderer.viewport.resizeRevision, revision);
      await snapshot(landscape, name);
    }
    await landscape.context.close();
    for (const [name, viewport, touch] of [
      ['constrained-landscape', { width: 740, height: 320 }, true],
      ['portrait', { width: 390, height: 844 }, true],
      ['desktop', { width: 1280, height: 800 }, false],
    ]) {
      const test = await newGame(name, viewport, { touch });
      await snapshot(test, `neutral-${viewport.width}x${viewport.height}`);
      await play(test, 1);
      await snapshot(test, `${name}-progressed`);
      await test.context.close();
    }
    const reduced = await newGame('reduced-motion', { width: 844, height: 390 }, { reduced: true });
    await play(reduced, 1, true);
    await snapshot(reduced, 'reduced-motion-static');
    await reduced.context.close();

    const spectator = await newGame('spectator', { width: 844, height: 390 }, { spectator: true });
    const spectatorDeadline = Date.now() + 90000;
    let spectatorTrace;
    while (Date.now() < spectatorDeadline) {
      spectatorTrace = await spectator.page.evaluate(() => window.__ux);
      if ([0, 1, 2, 3].every(seat =>
        spectatorTrace.moves.filter(move => move.kind === 'discard' && move.seat === seat).length >= 2)) break;
      await sleep(100);
    }
    assertTrace(spectatorTrace);
    const spectatorCounts = [0, 1, 2, 3].map(seat =>
      spectatorTrace.moves.filter(move => move.kind === 'discard' && move.seat === seat).length);
    assert(spectatorCounts.every(count => count >= 2), `Four-bot spectator did not complete two real orbits: ${spectatorCounts}`);
    assert(spectatorTrace.frames.every(frame => frame.actorSeat === null), 'Spectator must not acquire a human hand entitlement');
    write(path.join(output, 'spectator-trace.json'), spectatorTrace);
    await snapshot(spectator, 'spectator-two-orbits');
    receipt.cases.push({ name: 'actual-four-bot-spectator-two-orbits', discardsBySeat: spectatorCounts });
    await spectator.context.close();
    }

    {
      const test = await newGame('setup', { width: 844, height: 390 });
      const { page } = test, initialRoom = new URL(page.url()).searchParams.get('gameId');
      let submittedRoom = null;
      const normalize = value => JSON.parse([initialRoom, submittedRoom].filter(Boolean)
        .reduce((text, room) => text.replaceAll(room, '<ROOM>'), JSON.stringify(value)));
      const creationRequests = () => receipt.requests.filter(request => request.case === test.name
        && request.navigation).length;
      const open = async () => {
        for (const selector of ['#onboarding-skip', '#tour-skip']) {
          if (await page.locator(selector).isVisible()) await page.locator(selector).click();
        }
        if (!await page.locator('#lobby-panel').isVisible()) await page.locator('#lobby-toggle').click();
        await page.locator('#lobby-apply').waitFor({ state: 'visible' });
      };
      const controls = async () => normalize(await page.locator('#lobby-panel').evaluate(form =>
        [...form.querySelectorAll('input[name^="lobby-"],#ferro-variant-select,#lobby-base-unit,#lobby-seed,#lobby-rule-preset-select,#lobby-save-defaults')]
          .map(input => ({ key: input.id || `${input.name}:${input.value}`, name: input.name, type: input.type,
            value: input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value,
            required: input.required, min: input.min ?? '', max: input.max ?? '', step: input.step ?? '',
            pattern: input.pattern ?? '', disabled: input.disabled,
            options: input.tagName === 'SELECT' ? [...input.options].map(option => option.value) : null }))
          .sort((a, b) => a.key.localeCompare(b.key))));
      const advanced = page.locator('#lobby-advanced');
      const advancedOpen = () => advanced.evaluate(details => details.open);
      const disclose = async wanted => {
        if (await advancedOpen() !== wanted) await page.locator('#lobby-advanced > summary').click();
      };
      const realClick = async selector => {
        const input = page.locator(selector);
        const label = input.locator('xpath=..');
        if (await label.evaluate(parent => parent.tagName === 'LABEL')) await label.click();
        else await input.click();
      };
      await open();
      const defaults = await controls();
      assert(defaults.length > 0, 'Setup must inspect the retained actual controls');
      assert.equal(await page.locator('#lobby-panel #lobby-apply').count(), 1,
        'The retained setup must have one Start action');
      if (!capture) {
        assert.equal(await advancedOpen(), false, 'Native Advanced must initially be collapsed');
        const authority = () => page.evaluate(() => ({
          room: window.game?.adapter?.latest?.session?.gameId ?? null,
          sessionId: window.game?.adapter?.latest?.sessionId ?? null, url: location.href,
        }));
        const beforeDraft = await authority(), requestsBeforeDraft = creationRequests();
        const choice = page.locator('#ferro-variant-select'), previousValue = await choice.inputValue();
        assert.notEqual(previousValue, 'four-player');
        await choice.selectOption('four-player');
        assert.equal(await choice.inputValue(), 'four-player', 'The different variant must actually be selected');
        await page.waitForTimeout(300);
        assert.deepEqual(await authority(), beforeDraft,
          'Selecting a variant while setup is OPEN must not create/switch until Start');
        assert.equal(creationRequests(), requestsBeforeDraft, 'Draft variant selection must not submit creation/navigation');
        await choice.selectOption(previousValue);
        assert.deepEqual(await controls(), defaults, 'Restoring the draft variant must retain all Advanced values');
      }
      await disclose(true);
      assert.deepEqual(await controls(), defaults, 'Opening Advanced must preserve every existing value/constraint');
      await realClick('input[name="lobby-bot-count"][value="2"]');
      await realClick('input[name="lobby-deal-mode"][value="manual"]');
      await realClick('input[name="lobby-bot-difficulty"][value="Easy"]');
      await realClick('input[name="lobby-hand-count"][value="8"]');
      await realClick('input[name="lobby-seat"][value="0"]');
      await page.locator('#lobby-base-unit').fill('3');
      await page.locator('#lobby-seed').fill('424242');
      await realClick('#lobby-save-defaults');
      const saved = await controls();
      const beforeInvalid = page.url(), invalid = page.locator('#lobby-base-unit'), original = await invalid.inputValue();
      const requestsBeforeInvalid = creationRequests();
      await invalid.fill('not-a-number');
      assert.equal(await invalid.evaluate(input => input.checkValidity()), false);
      await disclose(false);
      await page.locator('#lobby-apply').click();
      await page.waitForTimeout(200);
      assert.equal(page.url(), beforeInvalid, 'Invalid setup must not create/navigate to another room');
      assert.equal(creationRequests(), requestsBeforeInvalid, 'Invalid settings must not submit a creation request');
      if (!capture) {
        assert(await advancedOpen(), 'An invalid Advanced field must be revealed');
        assert(await invalid.isVisible(), 'The real invalid field must be reachable');
      }
      await disclose(true);
      await invalid.fill(original);
      assert.deepEqual(await controls(), saved, 'Restoring the invalid field must preserve all chosen settings');
      await page.screenshot({ path: path.join(output, 'screenshots/setup-advanced.png') });
      await disclose(false);
      assert.deepEqual(await controls(), saved, 'Collapsing Advanced must not reset hidden settings');
      const start = page.locator('#lobby-apply');
      await start.scrollIntoViewIfNeeded();
      const box = await start.boundingBox();
      assert(box);
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 }), 'lobby-apply',
      'Start must actually be tappable, not just report visible');
      await page.screenshot({ path: path.join(output, 'screenshots/setup-simple.png') });
      const navigation = page.waitForRequest(request => request.isNavigationRequest()
        && request.frame() === page.mainFrame() && new URL(request.url()).searchParams.has('gameId'));
      await start.click();
      const submittedUrl = new URL((await navigation).url());
      submittedRoom = submittedUrl.searchParams.get('gameId');
      assert(submittedRoom && submittedRoom !== initialRoom, 'Changed real settings must create our own fresh room');
      await page.waitForURL(url => url.searchParams.get('gameId') === submittedRoom);
      await page.waitForFunction(actualRoomReady, submittedRoom);
      await snapshot(test, 'setup-started-actual-room');
      const submission = { kind: 'navigation', path: submittedUrl.pathname,
        parameters: Object.fromEntries([...submittedUrl.searchParams].sort(([a], [b]) => a.localeCompare(b))) };
      await page.goto(`${target.origin}/?action=none`, { waitUntil: 'domcontentloaded' });
      await open();
      await page.waitForFunction(() => document.getElementById('lobby-seed')?.value === '424242'
        && document.getElementById('lobby-base-unit')?.value === '3');
      const restored = await controls();
      const observed = { artifactKind: 'mahjong-ux-actual-setup', status: 'captured',
        target: target.origin, application: receipt.application, defaults, saved, restored, submission: normalize(submission) };
      write(path.join(output, 'setup.json'), observed);
      if (!capture) for (const field of ['defaults', 'saved', 'restored', 'submission']) {
        assert.deepEqual(observed[field], baseline[field], `Actual setup ${field} must preserve the BEFORE contract`);
      }
      receipt.cases.push({ name: 'actual-setup-simple-advanced-validation-and-saved-submission',
        controls: defaults.length, submission: observed.submission, baseline: baselineName });
      await test.context.close();
    }
    await browser.close(); browser = null;
    if (!setupOnly) {
    const manualPath = fs.realpathSync(path.resolve(root, manualName));
    assert(manualPath.startsWith(path.join(root, 'artifacts') + path.sep) && manualPath.endsWith('.json'));
    const manual = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
    assert.equal(manual.status, 'passed');
    assert.equal(new URL(manual.origin).origin, target.origin);
    assert.equal(manual.engine, 'webgl2');
    assert(manual.actions.some(action => action.operation === 'single-wall-pickup'));
    receipt.cases.push({ name: 'retained-canonical-manual-dice-and-wall-pickup',
      receipt: path.relative(root, manualPath), sha256: hash(fs.readFileSync(manualPath)),
      scope: 'Reused actual canonical manual deal start/pickup; not a completed manual hand.' });
    }
    assert.deepEqual(receipt.errors, []);
    assert.deepEqual(receipt.requests.filter(request => request.origin !== target.origin
      || /\/unity\/|\.wasm$|\.loader\.js$|\.framework\.js$/i.test(request.path)), []);
    receipt.status = capture ? 'captured' : 'passed';
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = { name: error.name, message: error.message };
    for (const [name, test] of traces) {
      const trace = await test.page.evaluate(() => window.__ux).catch(() => null);
      if (trace) write(path.join(output, `${name}-failure-trace.json`), trace);
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    receipt.completedAtUtc = new Date().toISOString();
    write(path.join(output, 'receipt.json'), receipt);
  }
  console.log(JSON.stringify({ status: receipt.status, approval: receipt.approval,
    output: path.relative(root, output), cases: receipt.cases.map(value => value.name), unqualified: receipt.unqualified }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
