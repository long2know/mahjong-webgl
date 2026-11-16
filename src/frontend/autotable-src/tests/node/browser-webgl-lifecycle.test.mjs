import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, require } from './renderer-test-support.mjs';

const { chromium } = require('@playwright/test');
const { build } = require('esbuild');
const sceneFixture = `
export class WebglScene {
  static async create(canvas) { return new WebglScene(canvas); }
  constructor(canvas) {
    this.canvas = canvas; this.gl = canvas.getContext('webgl2', { alpha: false, preserveDrawingBuffer: false });
    if (!this.gl) throw Error('Actual WebGL2 required');
    this.pending = null; this.committed = null; this.drawCount = 0; this.pan = [0,0];
    window.fixtureScene = this;
  }
  draw(layout, frame, viewport) {
    if (this.pending) throw Error('Overlapping real GPU fence');
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST); gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.clearColor(17/255,93/255,157/255,1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0,0,this.canvas.width,Math.ceil(viewport.handBandCssPx));
    gl.clearColor(230/255,220/255,190/255,1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
    this.pending = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),
      commit: {frame,viewport,plan:{},milliseconds:0} };
    gl.flush(); this.drawCount++;
  }
  poll() {
    if (!this.pending) return null;
    const result = this.gl.clientWaitSync(this.pending.sync,0,0);
    if (result === this.gl.TIMEOUT_EXPIRED) return null;
    if (result === this.gl.WAIT_FAILED) throw Error('Real GPU fence failed');
    this.gl.deleteSync(this.pending.sync); this.committed = this.pending.commit; this.pending = null;
    return this.committed;
  }
  cancelPending() { if(this.pending) this.gl.deleteSync(this.pending.sync); this.pending=null; }
  resetPresentation() {}
  reconcile() {}
  clear() {
    this.cancelPending();this.committed=null;this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.clearColor(0,0,0,1);this.gl.clear(this.gl.COLOR_BUFFER_BIT);this.gl.flush();
  }
  pick() { return null; }
  pickSlot() { return null; }
  dispose() { this.clear(); }
}`;

async function productionHost() {
  const output = await build({
    absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent',
    stdin: { resolveDir: root, contents: `
      import { WebglHost } from './src/renderer/webgl-host.ts';
      window.HostSource = WebglHost;
    ` },
    plugins: [{
      name: 'lifecycle-only-scene',
      setup(build) {
        build.onResolve({ filter: /^\.\/webgl-scene$/ }, () => ({ path: 'lifecycle-scene', namespace: 'lifecycle' }));
        build.onLoad({ filter: /.*/, namespace: 'lifecycle' }, () => ({ contents: sceneFixture, loader: 'js' }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'empty' }));
      },
    }],
  });
  return output.outputFiles[0].text;
}

async function pixels(page, name) {
  const image = await page.screenshot();
  if (process.env.CANVAS_LIFECYCLE_EVIDENCE === '1') {
    const directory = path.resolve(root, '../../../artifacts/canvas-lifecycle');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${name}.png`), image);
  }
  return page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return { board: [...ctx.getImageData(Math.floor(image.width * .4), Math.floor(image.height * .35), 1, 1).data],
      hand: [...ctx.getImageData(Math.floor(image.width * .4), image.height - 20, 1, 1).data] };
  }, [...image]);
}
const retained = (result, stage) => {
  assert.deepEqual(result.board, [17, 93, 157, 255], `${stage}: actual composited board pixels`);
  assert.deepEqual(result.hand, [230, 220, 190, 255], `${stage}: actual composited hand pixels`);
};

test('production host retains actual WebGL pixels through controlled blur/resize and repaints on visible resume without a click', async t => {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (executablePath !== undefined) assert(fs.existsSync(executablePath), 'CHROMIUM_EXECUTABLE_PATH must point to an installed browser');
  const runtime = path.resolve(root, `../../../.work/lifecycle-browser-${process.pid}`);
  fs.mkdirSync(runtime, { recursive: true });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = runtime;
  let browser;
  t.after(async () => {
    await browser?.close();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  browser = await chromium.launch({ ...(executablePath === undefined ? {} : { executablePath }), headless: true, timeout: 15000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-breakpad'],
    env: { ...process.env, HOME: runtime, XDG_CACHE_HOME: runtime, XDG_CONFIG_HOME: runtime } });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>
    html,body { margin:0;width:100%;height:100%;background:#000 }
    #main { position:absolute;inset:0 }
    #webgl-canvas { display:block;width:100%;height:100% }
    #renderer-status { position:absolute;inset:0;background:#111 }
    #renderer-status[hidden] { display:none }
    #fixture-hud { position:fixed;top:8px;left:8px;color:white;pointer-events:none }
    </style><main id="main"></main><span id="fixture-hud">Lifecycle fixture HUD</span>`);
  await page.addScriptTag({ content: await productionHost() });
  await page.evaluate(async () => {
    window.fixtureFocused = true; window.fixtureHidden = false;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => window.fixtureFocused });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fixtureHidden });
    let host = null, frameId = 0, layout;
    const publish = () => {
      if (!host || !layout) return;
      host.publish(layout, {
        contractVersion: '1.0.0', instanceId: host.instanceId, sessionId: 'fixture', type: 'frame', frameId: ++frameId, layoutRevision: 1,
        session: { gameId: null, mode: 'offline', connected: false, snapshotReady: false, actorSeat: null, viewSeat: null, viewerRevision: null },
        presentation: { viewMode: 'flat', boardLayout: 'classic', handLayout: 'separate', tileLabels: true, lookDown: 0, zoom: 0 },
        entities: [], seats: [], localHand: { seat: null, entityIds: [], drawnEntityId: null }, turn: null, pickup: null, dice: null, match: null,
      });
    };
    host = new window.HostSource(document.getElementById('main'), {
      action() { throw Error('Lifecycle transitions must not submit gameplay'); }, resized: publish, resumed: publish, failure() {}, notice() {},
    });
    host.clear('fixture', 'join');
    layout = { contractVersion: '1.0.0', instanceId: host.instanceId, sessionId: 'fixture', type: 'layout', layoutRevision: 1,
      gameType: 'CHANGSHA', activeSeats: [0,1,2,3], canonicalBoard: { width:174,depth:174 }, slots: [] };
    host.setPresentation({ handLayout: 'separate' }); publish();
    window.lifecycle = { host, publish };
    await host.mount();
  });
  await page.waitForFunction(() => window.lifecycle.host.state === 'ready' && !window.lifecycle.host.inFlight);
  retained(await pixels(page, '01-focused'), 'focused');
  const initial = await page.evaluate(() => ({ width: window.lifecycle.host.canvas.width, height: window.lifecycle.host.canvas.height,
    draws: window.fixtureScene.drawCount, preserve: window.fixtureScene.gl.getContextAttributes().preserveDrawingBuffer }));
  assert.equal(initial.preserve, false, 'exercise the production default-buffer policy, not a synthetic preserved context');
  await page.evaluate(() => { window.fixtureFocused = false; window.dispatchEvent(new Event('blur')); });
  await page.setViewportSize({ width: 780, height: 520 });
  await page.waitForTimeout(80);
  retained(await pixels(page, '02-blurred-resized'), 'blurred resize');
  const paused = await page.evaluate(() => ({
    width: window.lifecycle.host.canvas.width, height: window.lifecycle.host.canvas.height, draws: window.fixtureScene.drawCount,
    blocked: window.lifecycle.host.actionFrame() === null, scheduled: window.lifecycle.host.animation,
  }));
  assert.equal(paused.width, initial.width); assert.equal(paused.height, initial.height);
  assert.equal(paused.draws, initial.draws, 'no unfocused render loop or heartbeat');
  assert.equal(paused.blocked, true); assert.equal(paused.scheduled, 0);
  await page.evaluate(() => { window.fixtureHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.setViewportSize({ width: 800, height: 540 });
  await page.waitForTimeout(60);
  const prior = await page.evaluate(() => window.lifecycle.host.lastRendered);
  await page.evaluate(() => { window.fixtureHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(previous => window.lifecycle.host.lastRendered > previous && !window.lifecycle.host.inFlight, prior);
  retained(await pixels(page, '03-visible-unfocused'), 'visible without focus/click');
  assert(await page.evaluate(() => window.lifecycle.host.actionFrame() === null), 'one visual refresh does not grant focus/input');
  const settled = await page.evaluate(() => ({ draws: window.fixtureScene.drawCount, scheduled: window.lifecycle.host.animation }));
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.fixtureScene.drawCount), settled.draws);
  assert.equal(settled.scheduled, 0);
  await page.evaluate(() => { window.fixtureFocused = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => !window.lifecycle.host.inFlight && window.lifecycle.host.state === 'ready');
  retained(await pixels(page, '04-refocused'), 'refocused without click');
  await page.evaluate(() => {
    window.fixtureFocused = false; window.dispatchEvent(new Event('blur'));
    window.lifecycle.host.clear('revoked', 'authority-change');
  });
  const revoked = await pixels(page, '05-authority-revoked');
  assert.deepEqual(revoked.board, [0,0,0,255]); assert.deepEqual(revoked.hand, [0,0,0,255]);
  assert(await page.evaluate(() => window.lifecycle.host.actionFrame() === null));
  await page.evaluate(() => window.lifecycle.host.dispose());
  t.diagnostic('Production WebglHost + minimal actual WebGL2/fence scene; controlled document focus/visibility, not OS occlusion or a game/callout qualification.');
});
