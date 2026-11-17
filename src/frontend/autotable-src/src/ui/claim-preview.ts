import type { ClaimWindowEntry, ThingInfo } from '../types';
import { parseRealTileId, resolveTileFace } from '../changsha-mode-policy';
import { t } from '../i18n';
import { createTileFace, physicalTileFace, tileFaceName } from './tile-face';
import './claim-preview.css';

export interface OwnHandClient {
  seat: number | null;
  things: { entries(): Iterable<[string | number, ThingInfo | null]> };
}
export interface ClaimPreviewTile { tileId: number; face: number | null; origin: 'own' | 'discard' }

export function entitledHandFaces(client: OwnHandClient): Map<number, number> {
  const own = new Map<number, number>();
  const actor = client.seat;
  if (actor === null) return own;
  for (const [key, info] of client.things.entries()) {
    const id = parseRealTileId(key);
    if (id === null || !info || !info.slotName.startsWith('hand.') || !info.slotName.endsWith(`@${actor}`)) continue;
    const entitled = resolveTileFace(key, info.face).faceIndex;
    if (entitled !== null && Number.isInteger(entitled) && entitled >= 0 && entitled < 27) own.set(id, entitled);
  }
  return own;
}

export function claimPreview(
  client: OwnHandClient, claim: ClaimWindowEntry, type: 'Pung' | 'Chow' | 'Kong',
): ClaimPreviewTile[] | null {
  const face = physicalTileFace(claim.tile);
  if (face === null || !claim.available.includes(type)) return null;
  const own = entitledHandFaces(client);
  const count = type === 'Kong' ? 3 : 2;
  const ids = type === 'Chow' ? claim.chowOptions?.length === 1 ? claim.chowOptions[0] : []
    : [...own].filter(([, value]) => value === face).map(([id]) => id).sort((a, b) => a - b).slice(0, count);
  if (ids.length !== count || new Set(ids).size !== count || ids.some(id => !own.has(id))) return null;
  return [
    ...ids.map(tileId => ({ tileId, face: own.get(tileId)!, origin: 'own' as const })),
    { tileId: claim.tile, face, origin: 'discard' as const },
  ].sort((a, b) => a.face - b.face || a.tileId - b.tileId);
}

export function createClaimPreview(tiles: readonly ClaimPreviewTile[]): HTMLElement {
  const row = document.createElement('span');
  row.className = 'claim-tile-preview';
  for (const tile of tiles) {
    const cell = createTileFace(tile.face, 'claim-preview-tile', tile.origin);
    if (tile.face !== null) cell.dataset.tileId = String(tile.tileId);
    const label = `${tileFaceName(tile.face)} — ${t(tile.origin === 'discard' ? 'claims.offered_tile' : 'claims.your_tile')}`;
    cell.setAttribute('aria-label', label); cell.title = label; row.appendChild(cell);
  }
  return row;
}
