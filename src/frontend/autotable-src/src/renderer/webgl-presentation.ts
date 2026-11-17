import { Quaternion, Vector3 } from 'three';
import type { Entity, Frame, Viewport } from './renderer-contract';
import type { Placement, RenderPose, WebglPlan } from './webgl-layout';
import { isReducedMotionActive } from '../theme';

interface Motion {
  from: RenderPose; to: RenderPose; displayed: RenderPose; started: number; moving: boolean;
  separate: boolean; slot: string; group: Entity['group']; seat: number | null;
}
export interface MoveCue {
  entityId: string | null; kind: 'draw' | 'discard' | 'meld'; seat: number | null; sourceSeat: number | null; until: number;
}
export interface MeldCallout {
  key: string | null; seat: number; kind: 'pung' | 'chow' | 'kong' | 'meld'; started: number; until: number;
}
interface MeldSummary { seat: number | null; members: string; kind: MeldCallout['kind'] }
const playPhases = new Set(['AwaitingDiscard', 'AwaitingClaim', 'DeclaringKong', 'DrawingReplacement']);
const duration = 320;
const copy = (pose: RenderPose): RenderPose =>
  ({ position: pose.position.clone(), rotation: pose.rotation.clone(), scale: pose.scale });
const visible = (entity: Entity): boolean => entity.kind === 'TILE' && entity.appearance.knownFace
  && entity.appearance.showFace && entity.appearance.faceIndex !== null;
const publicMove = (entity: Entity): boolean => visible(entity) && (entity.group === 'discard' || entity.group === 'meld');
const same = (a: RenderPose, b: RenderPose): boolean => a.position.distanceToSquared(b.position) < 1e-10
  && Math.abs(a.rotation.dot(b.rotation)) > 1 - 1e-8 && Math.abs(a.scale - b.scale) < 1e-6;

function acceptedMelds(frame: Frame): Map<string, MeldSummary> {
  const summaries = new Map<string, MeldSummary>();
  // Relay layouts are freely arranged and cannot prove an accepted rule action.
  if (!frame.session.snapshotReady || frame.session.mode !== 'changsha'
    || frame.match?.conditions.gameType !== 'CHANGSHA') return summaries;
  const groups = new Map<string, Entity[]>();
  for (const entity of frame.entities) if (entity.kind === 'TILE' && entity.group === 'meld') {
    const key = `${entity.seat ?? '?'}:${Number.isSafeInteger(entity.indexes[0]) ? entity.indexes[0] : '?'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entity);
  }
  for (const [key, entities] of groups) {
    if (entities.some(entity => entity.display.held || entity.display.temporary)) continue;
    const seat = entities[0].seat;
    const positions = entities.map(entity => entity.indexes[1]).sort((a, b) => a - b);
    const members = positions.map(position => Number.isSafeInteger(position) ? position : '?').join(',');
    const canonical = entities.every(entity => entity.indexes.length === 2 && Number.isSafeInteger(entity.indexes[0])
      && entity.indexes[0] >= 0 && entity.indexes[0] < 4);
    const faces = entities.filter(visible).map(entity => entity.appearance.faceIndex!);
    let kind: MeldCallout['kind'] = 'meld';
    if (canonical && (members === '0,1,2,3' || members === '0,1,2,4')
      && new Set(faces).size <= 1) kind = 'kong';
    else if (canonical && members === '0,1,2' && faces.length === 3) {
      faces.sort((a, b) => a - b);
      if (faces[0] === faces[2]) kind = 'pung';
      else if (faces[0] >= 0 && faces[2] < 27 && Math.floor(faces[0] / 9) === Math.floor(faces[2] / 9)
        && faces[1] === faces[0] + 1 && faces[2] === faces[1] + 1) kind = 'chow';
    }
    // Faces and physical/hidden IDs are deliberately absent from the retained summary.
    summaries.set(key, { seat, members, kind });
  }
  return summaries;
}

/** Only current opaque IDs and poses are retained: never faces, retired tiles or an action queue. */
export class WebglPresentation {
  private readonly motions = new Map<string, Motion>();
  private space = '';
  private cue: MoveCue | null = null;
  private discard: string | null = null;
  private handCounts = new Map<number, number>();
  private phase: string | null = null;
  private reduced = false;
  private melds = new Map<string, MeldSummary>();
  private callout: MeldCallout | null = null;

  get latestDiscardId(): string | null { return this.discard; }
  get meldCallout(): MeldCallout | null { return this.callout; }

  clear(): void {
    this.motions.clear(); this.space = ''; this.cue = null; this.discard = null; this.handCounts.clear(); this.phase = null;
    this.melds.clear(); this.callout = null;
  }

  reconcile(frame: Frame): void {
    const entitled = new Map(frame.entities.map(entity => [entity.entityId, entity]));
    for (const [id, motion] of this.motions) {
      const current = entitled.get(id);
      if (!current || !visible(current)) this.motions.delete(id);
      else if (current.display.held) motion.moving = false;
    }
    const current = this.cue?.entityId ? entitled.get(this.cue.entityId) : null;
    if (this.cue?.entityId && (!current || !publicMove(current))) this.cue = null;
    const discarded = this.discard ? entitled.get(this.discard) : null;
    if (!discarded || discarded.group !== 'discard' || !visible(discarded)) this.discard = null;
    if (this.callout) {
      const current = acceptedMelds(frame);
      const summary = this.callout.key ? current.get(this.callout.key) : null;
      if (this.callout.key ? !summary || summary.kind !== this.callout.kind
        : ![...current.values()].some(group => group.seat === this.callout!.seat)) this.callout = null;
    }
  }

  apply(plan: WebglPlan, frame: Frame, viewport: Viewport, now = performance.now(),
    reduced = isReducedMotionActive()): MoveCue | null {
    const space = JSON.stringify([frame.instanceId, frame.sessionId, frame.layoutRevision,
      frame.session.gameId, frame.session.mode, frame.session.connected, frame.session.snapshotReady,
      frame.session.actorSeat, frame.session.viewSeat, frame.session.viewerRevision,
      frame.presentation.boardLayout, frame.presentation.handLayout, frame.presentation.viewMode, viewport.resizeRevision]);
    const snap = space !== this.space;
    if (snap) { this.clear(); this.space = space; }
    this.reconcile(frame);
    if (this.cue && now >= this.cue.until) this.cue = null;
    if (this.callout && now >= this.callout.until) this.callout = null;
    const accepted = acceptedMelds(frame);
    const changedMelds = [...accepted].filter(([key, group]) => this.melds.get(key)?.members !== group.members);
    if (!snap && changedMelds.length) {
      const actors = new Set(changedMelds.map(([, group]) => group.seat));
      const actor = changedMelds[0][1].seat;
      this.callout = actors.size === 1 && actor !== null && actor >= 0 && actor < 4 ? {
        key: changedMelds.length === 1 ? changedMelds[0][0] : null, seat: actor,
        kind: changedMelds.length === 1 ? changedMelds[0][1].kind : 'meld', started: now, until: now + 1050,
      } : null;
    }
    this.melds = accepted;
    const discards: MoveCue[] = [], melds: Array<MoveCue & { fromDiscard: boolean }> = [];
    const counts = new Map<number, number>();
    for (const entity of frame.entities) if (entity.group === 'hand' && entity.seat !== null) {
      counts.set(entity.seat, (counts.get(entity.seat) ?? 0) + 1);
    }
    for (const [id, placement] of plan.entities) {
      const { entity, pose: target, separate } = placement;
      if (!visible(entity)) continue;
      const previous = this.motions.get(id);
      const changed = !!previous && (previous.group !== entity.group || previous.seat !== entity.seat);
      const move = !snap && publicMove(entity) && (!previous || changed);
      if (move) {
        const cue: MoveCue = { entityId: id, kind: entity.group === 'meld' ? 'meld' : 'discard', seat: entity.seat,
          sourceSeat: previous?.seat ?? entity.seat, until: now + 650 };
        if (entity.group === 'discard') discards.push(cue);
        else melds.push({ ...cue, fromDiscard: previous?.group === 'discard' });
      }
      let motion = previous;
      if (!motion || !same(motion.to, target) || motion.separate !== separate) {
        const from = !snap && previous?.separate === separate
          ? previous.displayed : this.arrival(plan, frame, placement, !!previous);
        motion = {
          from: copy(from), to: copy(target), displayed: copy(target), started: now,
          moving: !snap && !reduced && !entity.display.held && !same(from, target),
          separate, slot: entity.slotName, group: entity.group, seat: entity.seat,
        };
        this.motions.set(id, motion);
      }
      if (reduced || this.reduced !== reduced || entity.display.held) motion.moving = false;
      motion.slot = entity.slotName; motion.group = entity.group; motion.seat = entity.seat;
      placement.pose = this.sample(motion, now);
      motion.displayed = copy(placement.pose);
    }
    if (discards.length > 1 || discards.length && melds.length) {
      this.discard = null; this.cue = null;
    } else if (discards.length === 1) {
      this.cue = discards[0]; this.discard = discards[0].entityId;
    } else if (melds.length) {
      this.cue = new Set(melds.map(cue => cue.seat)).size === 1 ? melds.find(cue => cue.fromDiscard) ?? melds[0] : null;
    } else if (!snap && playPhases.has(this.phase ?? '') && playPhases.has(frame.turn?.phase ?? '')) {
      // Hand counts are public; no relationship between disappearing hidden
      // handles and newly revealed physical IDs is inferred to announce a draw.
      const drawn = [...counts].filter(([seat, count]) => count === (this.handCounts.get(seat) ?? 0) + 1
        && frame.turn?.activeSeat === seat);
      if (drawn.length === 1) this.cue = {
        entityId: null, kind: 'draw', seat: drawn[0][0], sourceSeat: drawn[0][0], until: now + 650,
      };
    }
    this.handCounts = counts; this.phase = frame.turn?.phase ?? null;
    this.reduced = reduced;
    return this.cue;
  }

  private sample(motion: Motion, now: number): RenderPose {
    if (!motion.moving) return copy(motion.to);
    const progress = Math.max(0, Math.min(1, (now - motion.started) / duration));
    if (progress === 1) { motion.moving = false; return copy(motion.to); }
    const eased = 1 - (1 - progress) ** 3;
    const position = motion.from.position.clone().lerp(motion.to.position, eased);
    position.y += Math.sin(Math.PI * progress) * .025;
    return { position, rotation: motion.from.rotation.clone().slerp(motion.to.rotation, eased),
      scale: motion.from.scale + (motion.to.scale - motion.from.scale) * eased };
  }

  private arrival(plan: WebglPlan, frame: Frame, placement: Placement, crossedCamera: boolean): RenderPose {
    const { entity, pose } = placement, from = copy(pose);
    if (placement.separate || crossedCamera || !publicMove(entity) || entity.seat === null) {
      from.position.y += .045 * pose.scale;
      from.scale *= .92;
      return from;
    }
    // A reveal starts at a public seat anchor, not at a guessed concealed/wall identity.
    const side = (entity.seat - (frame.session.viewSeat ?? 0) + 4) % 4;
    const midpoint = plan.bounds.getCenter(new Vector3()), extent = plan.bounds.getSize(new Vector3());
    const anchor = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -side * Math.PI / 2));
    from.position.set(midpoint.x + anchor.x * extent.x * .43, pose.position.y + .035,
      midpoint.z + anchor.z * extent.z * .43);
    return from;
  }
}
