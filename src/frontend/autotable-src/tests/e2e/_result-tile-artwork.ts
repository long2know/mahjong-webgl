import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HandResultEntry } from '../../src/types';

export async function assertResultTileArtwork(page: Page, hand: readonly number[], names?: readonly string[]): Promise<void> {
  const tiles = page.locator('#result-hand .result-tile');
  await expect(tiles).toHaveCount(hand.length);
  await expect(page.locator('#result-hand button, #result-hand a, #result-hand .result-tile[tabindex]')).toHaveCount(0);
  if (hand.length === 0) return;
  await expect(page.locator('#result-hand')).toBeVisible();
  await page.locator('#result-hand').scrollIntoViewIfNeeded({ timeout: 5_000 });
  await expect.poll(() => tiles.evaluateAll(elements => elements.every(element =>
    (element as HTMLElement).dataset.art === 'ready'))).toBe(true);
  const grouped = await page.locator('#result-hand').getAttribute('data-grouped') === 'true';
  const rendered = await tiles.evaluateAll(elements => elements.map(element => {
    const tile = element as HTMLElement;
    const image = tile.querySelector('img') as HTMLImageElement | null;
    const row = tile.closest('.result-tile-group-tiles') as HTMLElement | null;
    const rect = tile.getBoundingClientRect();
    return {
      tileId: tile.dataset.tileId, face: tile.dataset.face, role: tile.getAttribute('role'),
      label: tile.getAttribute('aria-label'), title: tile.title, text: tile.textContent,
      image: image?.src, complete: image?.complete, naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight,
      x: image?.style.left, y: image?.style.top, winning: tile.dataset.winning,
      scrollable: row !== null && row.scrollWidth > row.clientWidth, keyboardScroll: row?.tabIndex === 0,
      width: rect.width, height: rect.height,
      painted: [rect.left + 8, (rect.left + rect.right) / 2, rect.right - 8].every(x =>
        [rect.top + 8, (rect.top + rect.bottom) / 2, rect.bottom - 8].every(y =>
          tile.contains(document.elementFromPoint(x, y)))),
    };
  }));
  expect(rendered.map(tile => Number(tile.tileId)).sort((a, b) => a - b)).toEqual([...hand].sort((a, b) => a - b));
  for (let i = 0; i < hand.length; i++) {
    const tile = rendered[i];
    const id = grouped ? Number(tile.tileId) : hand[i], face = Math.floor(id / 4);
    const expectedName = names?.[grouped ? hand.indexOf(id) : i] ?? `${face % 9 + 1} ${['characters', 'circles', 'bamboo'][Math.floor(face / 9)]}`;
    expect(tile.tileId).toBe(String(id));
    expect(tile.face).toBe(String(face));
    expect(tile.role).toBe('img');
    if (tile.winning === 'true') expect(tile.label).toContain(expectedName);
    else expect(tile.label).toBe(expectedName);
    expect(tile.title).toBe(expectedName);
    expect(tile.text).toBe(expectedName);
    expect(tile.complete).toBe(true);
    expect(tile.naturalWidth).toBe(1536); expect(tile.naturalHeight).toBe(1536);
    expect(parseFloat(tile.x!)).toBeCloseTo(-(face % 8) * 100, 2);
    expect(parseFloat(tile.y!)).toBeCloseTo(-(1536 / 288 - Math.floor(face / 8) - 1) * 100, 2);
    expect(tile.width).toBeGreaterThanOrEqual(36);
    expect(tile.height).toBeCloseTo(tile.width * 1.5, 1);
    if (tile.scrollable) expect(tile.keyboardScroll, 'wide special groups must remain keyboard-scrollable').toBe(true);
    else expect(tile.painted, `physical tile ${hand[i]} must not be clipped or covered`).toBe(true);
  }
  const images = [...new Set(rendered.map(tile => tile.image))];
  expect(images).toHaveLength(1);
  const imageUrl = images[0]!;
  expect(imageUrl, 'the result must use the retained licensed board tile atlas').toMatch(/Faces(?:Labelled)?\.[a-f0-9]+\.png$/);
  const decoded = await page.evaluate(async url => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight, complete: image.complete };
  }, imageUrl!);
  expect(decoded).toEqual({ width: 1536, height: 1536, complete: true });
  const response = await page.request.get(imageUrl!);
  expect(response.ok()).toBe(true);
  expect(await response.body()).toEqual(readFileSync(resolve(__dirname,
    imageUrl.includes('FacesLabelled.') ? '../../art/tiles/FacesLabelled.png' : '../../art/tiles/Faces.png')));
}

export async function captureResultTileArtwork(
  page: Page, info: TestInfo, name: string, provenance: 'controlled-component-fixture' | 'server-completed-hand',
  result: HandResultEntry,
): Promise<void> {
  const directory = process.env.RESULT_TILE_ARTIFACT_DIR;
  const png = directory ? join(directory, `${name}.png`) : info.outputPath(`${name}.png`);
  const json = directory ? join(directory, `${name}.json`) : info.outputPath(`${name}.json`);
  mkdirSync(dirname(png), { recursive: true });
  await page.screenshot({ path: png });
  writeFileSync(json, JSON.stringify({ provenance, viewport: page.viewportSize(), result }, null, 2));
  await info.attach(name, { path: png, contentType: 'image/png' });
  await info.attach(`${name}-provenance`, { path: json, contentType: 'application/json' });
}
