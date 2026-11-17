import type { HandResultEntry, HandResultGroup } from '../types';
import { t } from '../i18n';
import { createPhysicalTileFace, physicalTileFace } from './tile-face';
import './result-hand.css';

const kinds = new Set(['chow', 'pung', 'pair', 'concealedKong', 'exposedKong', 'addedKong', 'special']);

export function validatedResultGroups(hand: readonly number[], value: unknown): HandResultGroup[] | null {
  if (!Array.isArray(value) || !value.length || !hand.length || hand.some(tile => physicalTileFace(tile) === null)
    || new Set(hand).size !== hand.length) return null;
  const remaining = new Set(hand);
  for (const group of value) {
    if (!group || !kinds.has(group.kind) || typeof group.exposed !== 'boolean'
      || !Array.isArray(group.tileIds) || !group.tileIds.length) return null;
    const expected = group.kind === 'pair' ? 2 : group.kind === 'chow' || group.kind === 'pung' ? 3
      : group.kind === 'special' ? null : 4;
    if (expected !== null && group.tileIds.length !== expected) return null;
    if (['pair', 'special', 'concealedKong'].includes(group.kind) && group.exposed
      || ['exposedKong', 'addedKong'].includes(group.kind) && !group.exposed) return null;
    for (const tile of group.tileIds) {
      if (physicalTileFace(tile) === null || !remaining.delete(tile)) return null;
    }
  }
  return remaining.size ? null : value;
}

export function renderResultTiles(root: HTMLElement, hand: readonly number[], result?: HandResultEntry): void {
  root.innerHTML = '';
  const groups = result?.type === 'Hu' ? validatedResultGroups(hand, result.handGroups) : null;
  const wire = result as HandResultEntry & {
    winResult?: { winningTileId?: unknown }; WinResult?: { WinningTileId?: unknown };
  } | undefined;
  const offeredWin = wire?.winResult?.winningTileId ?? wire?.WinResult?.WinningTileId;
  const winning = result?.type === 'Hu' && physicalTileFace(offeredWin) !== null
    && hand.filter(tile => tile === offeredWin).length === 1 ? offeredWin : null;
  const tile = (id: number): HTMLElement => {
    const cell = createPhysicalTileFace(id, `result-tile${physicalTileFace(id) === null ? ' result-tile-unknown' : ''}`);
    if (winning !== null && id === winning) {
      cell.dataset.winning = 'true';
      cell.setAttribute('aria-label', `${cell.getAttribute('aria-label')} — ${t('result_dialog.winning_tile')}`);
    }
    if (physicalTileFace(id) === null) console.warn('[result] Invalid winning-hand tile ID; displaying an unknown tile.');
    return cell;
  };
  if (groups) {
    root.dataset.grouped = 'true';
    for (const group of groups) {
      const section = document.createElement('section');
      section.className = 'result-tile-group'; section.dataset.kind = group.kind; section.dataset.exposed = String(group.exposed);
      const heading = document.createElement('span');
      heading.className = 'result-tile-group-label';
      heading.textContent = `${t(`result_group.${group.kind}`)} · ${t(group.exposed ? 'result_group.exposed' : 'result_group.concealed')}`;
      const tiles = document.createElement('div');
      tiles.className = 'result-tile-group-tiles';
      if (group.kind === 'special') { tiles.tabIndex = 0; tiles.setAttribute('aria-label', heading.textContent); }
      for (const id of group.tileIds) tiles.appendChild(tile(id));
      section.appendChild(heading); section.appendChild(tiles); root.appendChild(section);
    }
  } else {
    root.dataset.grouped = 'false';
    for (const id of hand) root.appendChild(tile(id));
    if (hand.length && result?.type === 'Hu') {
      const note = document.createElement('small');
      note.className = 'result-groups-unavailable'; note.textContent = t('result_group.unavailable'); root.appendChild(note);
    }
  }
}
