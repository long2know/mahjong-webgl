import { t } from '../i18n';
import './tile-face.css';

const atlases = [
  new URL('../../art/tiles/Faces.png', import.meta.url).href,
  new URL('../../art/tiles/FacesLabelled.png', import.meta.url).href,
];

export function physicalTileFace(tileId: unknown): number | null {
  return typeof tileId === 'number' && Number.isInteger(tileId) && tileId >= 0 && tileId < 108
    ? Math.floor(tileId / 4) : null;
}

export function tileFaceName(face: number | null): string {
  return face === null ? t('result_dialog.unknown_tile')
    : t('hand.tile', { rank: face % 9 + 1, suit: t(`hand.suit_${Math.floor(face / 9)}`) });
}

export function createTileFace(face: number | null, className = '', role: 'discard' | 'own' | null = null): HTMLElement {
  const cell = document.createElement('span');
  const valid = face !== null && Number.isInteger(face) && face >= 0 && face < 27;
  const label = tileFaceName(valid ? face : null);
  cell.className = `mahjong-tile ${className}${valid ? '' : ' mahjong-tile-unknown'}`.trim();
  cell.setAttribute('role', 'img');
  cell.setAttribute('aria-label', label);
  cell.title = label;
  if (role) cell.dataset.origin = role;
  const fallback = document.createElement('span');
  fallback.className = 'mahjong-tile-fallback'; fallback.textContent = valid ? label : '?';
  cell.appendChild(fallback);
  if (!valid) return cell;
  cell.dataset.face = String(face);
  cell.dataset.art = 'loading';
  const image = document.createElement('img');
  image.className = 'mahjong-tile-art'; image.alt = ''; image.setAttribute('aria-hidden', 'true');
  image.draggable = false;
  image.style.left = `${-(face % 8) * 100}%`;
  image.style.top = `${-(1536 / 288 - Math.floor(face / 8) - 1) * 100}%`;
  image.addEventListener('load', () => { cell.dataset.art = 'ready'; });
  image.addEventListener('error', () => {
    cell.dataset.art = 'unavailable';
    const warning = t('tiles.art_unavailable');
    const description = cell.getAttribute('aria-label') ?? label;
    cell.title = `${description} — ${warning}`;
    cell.setAttribute('aria-label', `${description} — ${warning}`);
    const note = document.createElement('span');
    note.className = 'mahjong-tile-art-error'; note.textContent = warning; cell.appendChild(note);
  }, { once: true });
  const labelled = (document.getElementById('tile-labels') as HTMLInputElement | null)?.checked ?? true;
  image.src = atlases[labelled ? 1 : 0];
  cell.appendChild(image);
  return cell;
}

export function createPhysicalTileFace(tileId: unknown, className = '', role: 'discard' | 'own' | null = null): HTMLElement {
  const cell = createTileFace(physicalTileFace(tileId), className, role);
  if (physicalTileFace(tileId) !== null) cell.dataset.tileId = String(tileId);
  return cell;
}
