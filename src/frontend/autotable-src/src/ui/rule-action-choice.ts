import { t } from '../i18n';
import { showToast } from '../toast';
import { createClaimPreview, entitledHandFaces, type ClaimPreviewTile, type OwnHandClient } from './claim-preview';
import { physicalTileFace } from './tile-face';

export type RuleChoiceKind = 'chow' | 'concealedKong' | 'addedKong';

export interface RuleTileChoice {
  tileIds: ReadonlyArray<number>;
  label: () => string;
  shownTileIds?: ReadonlyArray<number>;
  discardedTileId?: number;
}

export class RuleActionChoice {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly options: HTMLElement;
  private readonly cancel: HTMLButtonElement;
  private context: string | null = null;
  private labels: Array<{ label: HTMLElement; detail: HTMLElement; preview: HTMLElement; choice: RuleTileChoice; ids: number[] }> = [];

  constructor(private readonly client?: OwnHandClient) {
    this.dialog = document.getElementById('rule-action-choice-dialog') as HTMLDialogElement;
    this.title = document.getElementById('rule-action-choice-title')!;
    this.hint = document.getElementById('rule-action-choice-hint')!;
    this.options = document.getElementById('rule-action-choices')!;
    this.cancel = document.getElementById('rule-action-choice-cancel') as HTMLButtonElement;
    this.cancel.onclick = () => this.close();
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    // Native dialog Escape cancels a choice, not the underlying discard claim.
    this.dialog.addEventListener('keydown', (event) => event.stopPropagation());
    this.dialog.addEventListener('keyup', (event) => event.stopPropagation());
    this.localize();
  }

  get contextKey(): string | null {
    return this.context;
  }

  localize(): void {
    this.title.textContent = t(this.dialog.dataset.kind === 'chow'
      ? 'actions.choose_chow' : 'actions.choose_kong');
    this.hint.textContent = t('actions.choice_hint');
    this.cancel.textContent = t('common.cancel');
    for (const record of this.labels) this.renderChoice(record);
  }

  private renderChoice({ label, detail, preview, choice, ids }: typeof this.labels[number]): void {
    let tiles: ClaimPreviewTile[] | null = null;
    if (choice.shownTileIds) {
      const own = this.client ? entitledHandFaces(this.client) : new Map<number, number>();
      tiles = choice.shownTileIds.map(tileId => ({
        tileId, face: tileId === choice.discardedTileId ? physicalTileFace(tileId) : own.get(tileId) ?? null,
        origin: tileId === choice.discardedTileId ? 'discard' : 'own',
      }));
    }
    label.textContent = tiles?.some(tile => tile.face === null) ? t('claims.partners_unavailable') : choice.label();
    detail.textContent = tiles ? t('claims.preview_legend') : t('actions.physical_tiles', { ids: ids.join(', ') });
    preview.replaceChildren(...(tiles ? [createClaimPreview(tiles)] : []));
  }

  show(
    kind: RuleChoiceKind,
    context: string,
    choices: ReadonlyArray<RuleTileChoice>,
    choose: (tileIds: number[], context: string) => void,
  ): void {
    if (this.context === context && this.dialog.dataset.kind === kind && this.dialog.open) return;
    this.close();
    this.context = context;
    this.dialog.dataset.kind = kind;
    this.localize();
    this.options.replaceChildren();
    for (const choice of choices) {
      const tileIds = [...choice.tileIds];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rule-action-choice';
      button.dataset.tileIds = tileIds.join(',');
      const label = document.createElement('span');
      const detail = document.createElement('small');
      detail.className = 'rule-action-choice-detail';
      const preview = document.createElement('span');
      preview.className = 'rule-action-choice-preview';
      button.append(label, preview, detail);
      const record = { label, detail, preview, choice, ids: tileIds };
      this.labels.push(record); this.renderChoice(record);
      button.onclick = () => {
        if (this.context !== context || !this.dialog.open) {
          showToast(t('actions.unavailable'), 'info');
          return;
        }
        this.close();
        choose(tileIds, context);
      };
      this.options.appendChild(button);
    }
    this.dialog.showModal();
  }

  close(): void {
    this.context = null;
    if (this.dialog.open) this.dialog.close();
    this.options.replaceChildren();
    this.labels = [];
  }
}
