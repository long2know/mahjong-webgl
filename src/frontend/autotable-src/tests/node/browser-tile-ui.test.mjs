import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, require } from './renderer-test-support.mjs';
const { chromium } = require('@playwright/test');
const { build } = require('esbuild');

async function modules() {
  const output = await build({
    absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent',
    stdin: { resolveDir: root, contents: `
      import { renderResultTiles } from './src/ui/result-hand.ts';
      import { ClaimWindowOverlay } from './src/ui/claim-window-overlay.ts';
      import { installBrowserShell } from './src/browser-shell.ts';
      window.TileUiSource = { renderResultTiles, ClaimWindowOverlay, installBrowserShell };
    ` },
    plugins: [{
      name: 'local-tile-art-fixture',
      setup(build) {
        build.onLoad({ filter: /tile-face\.ts$/ }, args => ({
          contents: fs.readFileSync(args.path, 'utf8').replace(/\bimport\.meta\.url/g, JSON.stringify('http://tile-ui.fixture/src/ui/tile-face.ts')),
          loader: 'ts',
        }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'empty' }));
        build.onLoad({ filter: /renderer\/webgl-(?:scene|presentation)\.ts$/ }, () => {
          throw Error('The independent tile UI fixture must not load renderer/callout artifacts');
        });
      },
    }],
  });
  return output.outputFiles[0].text;
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
const css = [
  'node_modules/bootstrap/dist/css/bootstrap.css', 'src/style.css', 'src/main.css',
  'src/ui/hicks-mobile-sidebar.css', 'src/browser-shell.css', 'src/mobile-table.css',
  'src/ui/rule-action-controls.css', 'src/ui/claim-window-overlay.css',
  'src/ui/tile-face.css', 'src/ui/result-hand.css', 'src/ui/claim-preview.css',
].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

async function evidence(page, label) {
  if (process.env.TILE_UI_EVIDENCE !== '1') return;
  const directory = path.resolve(root, '../../../artifacts/tile-ui');
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${label}.png`) });
}
async function loaded(page, selector) {
  await page.waitForFunction(selector => {
    const tiles = [...document.querySelectorAll(selector)];
    return tiles.length > 0 && tiles.every(tile => tile.dataset.art === 'ready');
  }, selector);
}

test('real browser paints licensed grouped winning tiles and exact legal claim alternatives at portrait, landscape and desktop sizes', async t => {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (executablePath !== undefined) assert(fs.existsSync(executablePath), 'CHROMIUM_EXECUTABLE_PATH must point to an installed browser');
  const runtime = path.resolve(root, `../../../.work/u${process.pid}`);
  fs.mkdirSync(runtime, { recursive: true });
  const previous = process.env.TMPDIR; process.env.TMPDIR = runtime;
  let browser;
  t.after(async () => {
    await browser?.close();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  browser = await chromium.launch({ ...(executablePath === undefined ? {} : { executablePath }), headless: true, timeout: 15000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-breakpad'],
    env: { ...process.env, HOME: runtime, XDG_CACHE_HOME: runtime, XDG_CONFIG_HOME: runtime } });
  const bundle = await modules();
  for (const [name, width, height] of [['portrait', 390, 844], ['landscape', 844, 390], ['desktop', 1280, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.route('**/*', route => {
        const url = new URL(route.request().url()), asset = /^\/art\/tiles\/(Faces(?:Labelled)?\.png)$/.exec(url.pathname);
        if (asset) return route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(root, 'art/tiles', asset[1])) });
        if (url.pathname === '/autotable/') return route.fulfill({ contentType: 'text/html',
          body: html.replace('</head>', `<style>${css}</style></head>`) });
        return route.abort();
      });
      await page.goto('http://tile-ui.fixture/autotable/?gameId=tile-room&variant=changsha');
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        document.body.className = 'variant-changsha theme-dark';
        document.getElementById('chat-panel').hidden = false;
        window.TileUiSource.installBrowserShell();
        const groups = [
          { kind: 'pung', tileIds: [76, 77, 78], exposed: true },
          { kind: 'chow', tileIds: [52, 56, 60], exposed: false },
          { kind: 'chow', tileIds: [8, 12, 16], exposed: false },
          { kind: 'chow', tileIds: [20, 24, 28], exposed: false },
          { kind: 'pair', tileIds: [4, 5], exposed: false },
        ];
        const value = { type: 'Hu', winner: 1, score: [], nextBanker: 1, handGroups: groups,
          hand: groups.flatMap(group => group.tileIds), winResult: { winningTileId: 5 } };
        window.TileUiSource.renderResultTiles(document.getElementById('result-hand'), value.hand, value);
        document.getElementById('result-winner').textContent = 'Bamboo Fox wins';
        document.getElementById('result-dialog-status').textContent = 'Review the result, then Continue.';
        const modal = document.getElementById('result-modal');
        modal.classList.add('show'); modal.style.display = 'block'; modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
      });
      await loaded(page, '#result-hand .mahjong-tile');
      const groups = await page.locator('#result-hand .result-tile-group').evaluateAll(elements => elements.map(element => ({
        rect: element.getBoundingClientRect().toJSON(),
        tiles: [...element.querySelectorAll('.result-tile')].map(tile => tile.getBoundingClientRect().toJSON()),
      })));
      assert.equal(groups.length, 5);
      for (const group of groups) assert(group.tiles.every(tile => Math.abs(tile.top - group.tiles[0].top) < 1),
        `${name}: group members must never wrap into a different row`);
      assert.equal(await page.locator('#result-hand [data-winning="true"]').count(), 1);
      const continueBounds = await page.locator('#result-next').boundingBox();
      assert(continueBounds.y >= 0 && continueBounds.y + continueBounds.height <= height, `${name}: Continue remains reachable`);
      const tilePng = await page.locator('#result-hand .result-tile').first().screenshot();
      const ink = await page.evaluate(async bytes => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(4, 4, image.width - 8, image.height - 8).data;
        let colored = 0;
        for (let index = 0; index < pixels.length; index += 4) if (Math.min(...pixels.slice(index, index + 3)) < 130) colored++;
        return colored;
      }, [...tilePng]);
      assert(ink > 30, `${name}: the composed tile contains actual artwork, not a blank ivory card`);
      await evidence(page, `${name}-result`);
      await page.evaluate(() => {
        const modal = document.getElementById('result-modal'); modal.style.display = 'none'; modal.classList.remove('show');
        document.body.classList.remove('modal-open');
        const collection = values => { const data = new Map(values); return { data, get: key => data.get(key) ?? null, entries: () => data.entries() }; };
        const listeners = new Map();
        const claim = { gameId: 'runtime-room', stateVersion: 7, available: ['Pung', 'Kong'], source: 2, tile: 43, deadline: Date.now() + 8000 };
        const client = {
          seat: 0, lastGameId: 'tile-room', serverSnapshotGameId: 'tile-room', seatPlayers: ['self', 'bot-one', 'bot-two', 'bot-three'],
          connected: () => true, playerId: () => 'self', sent: [],
          on(event, listener) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(listener); },
          emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args); },
          update(entries) { this.sent.push(entries); },
          claim: collection([['0', claim]]), ownTurn: collection([]),
          turn: collection([['current', { phase: 'AwaitingClaim', activeSeat: 0 }]]),
          gameComplete: collection([]), actionRejected: collection([]),
          nicks: collection([['self', 'Human One'], ['bot-one', 'Bamboo Fox'], ['bot-two', 'Jade Otter'], ['bot-three', 'Crimson Crane']]),
          things: collection([40, 41, 42].map(id => [String(id), { slotName: `hand.${id}@0`, face: 10 }])),
        };
        window.tileClient = client;
        window.tileOverlay = new window.TileUiSource.ClaimWindowOverlay({ client }); window.tileOverlay.attach();
      });
      await loaded(page, '#claim-window-actions .mahjong-tile');
      assert.equal(await page.locator('.ferro-claim-tile-source').innerText(), 'Jade Otter · West');
      assert.equal(await page.locator('.ferro-claim-badge-chow').isVisible(), false);
      const claimBounds = await page.locator('#claim-window-actions').boundingBox();
      assert(claimBounds.x >= 0 && claimBounds.y >= 0 && claimBounds.x + claimBounds.width <= width + 1
        && claimBounds.y + claimBounds.height <= height, `${name}: claim preview stays inside the viewport`);
      await evidence(page, `${name}-claim`);
      assert.equal(await page.evaluate(() => window.tileClient.sent.length), 0);
      await page.evaluate(() => {
        const client = window.tileClient;
        client.things.data.clear();
        for (const id of [36, 40, 48]) client.things.data.set(String(id), { slotName: `hand.${id}@0`, face: Math.floor(id / 4) });
        const claim = { gameId: 'runtime-room', stateVersion: 8, available: ['Chow'], source: 2, tile: 44,
          deadline: Date.now() + 8000, chowOptions: [[36, 40], [40, 48]] };
        client.claim.data.set('0', claim); client.emit('update', [['claim', '0', claim]], false);
      });
      await page.locator('.ferro-claim-badge-chow').click();
      await loaded(page, '#rule-action-choices .mahjong-tile');
      const fallbacks = await page.locator('#rule-action-choices .mahjong-tile-fallback').evaluateAll(elements =>
        elements.map(element => getComputedStyle(element).display));
      assert(fallbacks.every(display => display === 'none'), `${name}: loaded faces must not be obscured by fallback text`);
      assert.equal(await page.evaluate(() => window.tileClient.sent.length), 0);
      assert.equal(await page.locator('#rule-action-choices .rule-action-choice').count(), 2);
      const cancel = await page.locator('#rule-action-choice-cancel').boundingBox();
      assert(cancel.y >= 0 && cancel.y + cancel.height <= height, `${name}: Cancel remains touch-reachable`);
      await evidence(page, `${name}-chow-options`);
      await page.locator('#rule-action-choices .rule-action-choice').nth(1).click();
      assert.deepEqual(await page.evaluate(() => window.tileClient.sent), [[['claim', '0', {
        action: 'claim', type: 'Chow', tileIds: [40, 48], gameId: 'runtime-room', expectedVersion: 8,
      }]]]);
    } finally { await context.close(); }
  }
  t.diagnostic('Production result/claim components and original licensed PNGs; controlled public/own data, not a completed server hand or backend claim acceptance.');
});
