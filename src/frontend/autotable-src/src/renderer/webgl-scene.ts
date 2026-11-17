import { Box3, Matrix4, Vector3 } from 'three';
import { compileProgram } from './gpu/program';
import {
  beveledTileGeometry, createTileMesh, disposeTileMesh, drawTileMesh, setTileInstance, uploadTileInstances,
  TILE_DEPTH, TILE_HEIGHT, TILE_WIDTH, TILE_INSTANCE_VS, type TileMesh,
} from './gpu/tile-mesh';
import { invertMatrix4, pickTile, type PickRay } from './gpu/picking';
import type { Frame, Layout, Viewport } from './renderer-contract';
import { buildWebglPlan, fittedCamera, projectTableBounds, tileModel, type Rect, type RenderPose, type WebglPlan } from './webgl-layout';
import { pickableModels, tileMaterialId, tileSurface, TABLE_FELT_Y, TABLE_SHADOW_Y } from './webgl-style';
import { WebglPresentation, type MeldCallout, type MoveCue } from './webgl-presentation';
import { t } from '../i18n';
import { isReducedMotionActive } from '../theme';

const faceAtlases = [
  new URL('../../art/tiles/Faces.png', import.meta.url).href,
  new URL('../../art/tiles/FacesLabelled.png', import.meta.url).href,
];

const fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_lighting;
flat in float v_tileId;
uniform sampler2D u_atlas;
uniform vec2 u_atlasGrid;
out vec4 fragColor;
void main() {
  float row = mod(floor(v_tileId), 64.0);
  float side = clamp(floor(v_uv.x - 0.00001), 0.0, 2.0);
  vec2 localUv = vec2(fract(v_uv.x),1.0-v_uv.y);
  vec2 uv = clamp(localUv,vec2(0.015),vec2(0.985));
  if (row == 61.0) {
    if (side > 0.5) discard;
    float edge = length(max(abs(localUv-0.5)-vec2(0.31,0.36),vec2(0.0)));
    float alpha = (1.0-smoothstep(0.0,0.17,edge))*fract(v_tileId);
    if (alpha < 0.005) discard;
    fragColor = vec4(0.012,0.022,0.020,alpha);
    return;
  }
  if (row < 37.0 && side > 0.5 && side < 1.5) row = 37.0+mod(floor(v_tileId/64.0),2.0);
  vec2 cell = vec2(mod(row, 8.0)*3.0+side, floor(row/8.0));
  vec4 base = texture(u_atlas, (cell+uv)/u_atlasGrid);
  if (row == 40.0 || row == 62.0) {
    float grain = fract(sin(dot(localUv, vec2(127.1,311.7)))*43758.5453);
    vec2 spot = (localUv-vec2(0.47,0.52))*vec2(1.0,0.92);
    base.rgb *= 0.87+0.13*exp(-dot(spot,spot)*3.2)+0.014*(grain-0.5);
  }
  if (row == 62.0 || row == 63.0) {
    if (side > 0.5) discard;
    vec2 p = abs(localUv-0.5)-vec2(0.475);
    float distance = length(max(p,vec2(0.0)))+min(max(p.x,p.y),0.0)-0.025;
    float aa = max(fwidth(distance),0.0005);
    float alpha = 1.0-smoothstep(-aa,aa,distance);
    if (alpha < 0.005) discard;
    fragColor = vec4(base.rgb,alpha);
    return;
  }
  bool plastic = row < 40.0 || row == 41.0 || row == 60.0 || (row >= 45.0 && row <= 57.0);
  fragColor = vec4(plastic ? base.rgb*v_lighting.x+vec3(v_lighting.y) : base.rgb,1.0);
}`;
interface Target { kind: 'entity' | 'dice'; id: string | null }
interface Batch { mesh: TileMesh; targets: Array<Target | null> }
interface SlotBatch { modelData: Float32Array; instanceCount: number; names: string[] }
interface PickBatch { modelData: Float32Array; instanceCount: number; targets: Array<Target | null> }
export interface SceneCommit {
  frame: Frame; plan: WebglPlan; viewport: Viewport; milliseconds: number; cue: MoveCue | null; discardId: string | null;
  meldCallout: MeldCallout | null;
}
const capacity = 4096;
const emptySlots = (): SlotBatch => ({ modelData: new Float32Array(capacity * 16), instanceCount: 0, names: [] });
const solidPose = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Float32Array => {
  const matrix = new Matrix4().makeScale(sx, sz / (20 / 12), sy / (8 / 12));
  matrix.premultiply(new Matrix4().set(
    1, 0, 0, x, 0, 0, 1, y, 0, -1, 0, -z, 0, 0, 0, 1,
  ));
  return Float32Array.from(matrix.elements);
};

function pickRay(rect: Rect, x: number, y: number, matrix: Float32Array): PickRay {
  const inverse = invertMatrix4(matrix);
  if (!inverse) throw Error('Camera matrix is singular.');
  const transform = (z: number): [number, number, number] => {
    const point = new Vector3((x - rect.x) / rect.width * 2 - 1, 1 - (y - rect.y) / rect.height * 2, z)
      .applyMatrix4(new Matrix4().fromArray(inverse));
    return [point.x, point.y, point.z];
  };
  const origin = transform(-1), end = transform(1);
  const direction = new Vector3(...end).sub(new Vector3(...origin)).normalize();
  return { origin, direction: [direction.x, direction.y, direction.z] };
}
const contains = (rect: Rect, x: number, y: number): boolean =>
  rect.height > 0 && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

export function seatLabelRect(board: Rect, hand: Rect | null, side: number, width: number, height: number,
  blocked: Rect[]): Rect {
  const left = board.x + 6, top = board.y + 6;
  const right = board.x + board.width - width - 6, bottom = board.y + board.height - height - 6;
  const positions = [[left, bottom], [right, board.y + (board.height - height) / 2], [right, top], [left, board.y + (board.height - height) / 2]];
  const candidates: number[][] = [];
  if (hand) {
    const before = hand.x - width - 8, after = hand.x + hand.width + 8;
    const above = hand.y - height - 8, below = hand.y + hand.height + 8;
    const middle = hand.y + (hand.height - height) / 2, across = hand.x + hand.width - width;
    candidates.push(...(side % 2
      ? [[side === 1 ? after : before, middle], [side === 1 ? before : after, middle],
        [side === 1 ? right : left, above], [side === 1 ? right : left, below]]
      : [[after, middle], [before, middle], [across, side === 2 ? below : above]]));
  }
  candidates.push(positions[side], ...(side % 2
    ? [[side === 1 ? right : left, top], [side === 1 ? right : left, bottom]]
    : [[side === 2 ? left : right, side === 2 ? top : bottom]]));
  let best: Rect | null = null, leastOverlap = Infinity;
  const resolve = (): Rect | null => {
    for (const [x, y] of candidates) {
      const result = { x: Math.max(left, Math.min(right, x)), y: Math.max(top, Math.min(bottom, y)), width, height };
      const overlap = blocked.reduce((sum, other) => sum
        + Math.max(0, Math.min(result.x + width, other.x + other.width + 3) - Math.max(result.x, other.x - 3))
        * Math.max(0, Math.min(result.y + height, other.y + other.height + 3) - Math.max(result.y, other.y - 3)), 0);
      if (!overlap) return result;
      if (overlap < leastOverlap) { best = result; leastOverlap = overlap; }
    }
    return null;
  };
  const preferred = resolve();
  if (preferred) return preferred;
  // Travel can occupy every usual anchor; search the current obstacles' edge clearances too.
  candidates.length = 0;
  const xs = [...new Set([left, right, ...blocked.flatMap(other => [other.x - width - 4, other.x + other.width + 4])]
    .map(x => Math.max(left, Math.min(right, x))))].sort((a, b) => Math.abs(a - positions[side][0]) - Math.abs(b - positions[side][0]));
  const ys = [...new Set([top, bottom, ...blocked.flatMap(other => [other.y - height - 4, other.y + other.height + 4])]
    .map(y => Math.max(top, Math.min(bottom, y))))].sort((a, b) => Math.abs(a - positions[side][1]) - Math.abs(b - positions[side][1]));
  if (side % 2) {
    for (const y of ys) candidates.push([positions[side][0], y], [side === 1 ? left : right, y]);
    for (const x of xs) candidates.push([x, top], [x, bottom]);
  } else {
    for (const x of xs) candidates.push([x, positions[side][1]], [x, side === 2 ? bottom : top]);
    for (const y of ys) candidates.push([left, y], [right, y]);
  }
  return resolve() ?? best!;
}

export function meldCalloutRect(board: Rect, seat: Rect, side: number, width: number, height: number,
  visible: Rect, blocked: Rect[] = []): Rect | null {
  const left = Math.max(board.x, visible.x) + 6, top = Math.max(board.y, visible.y) + 6;
  const right = Math.min(board.x + board.width, visible.x + visible.width) - 6;
  const bottom = Math.min(board.y + board.height, visible.y + visible.height) - 6;
  if (width <= 0 || height <= 0 || width > right - left || height > bottom - top) return null;
  const above = seat.y - height - 8, below = seat.y + seat.height + 8;
  const across = seat.x + (seat.width - width) / 2, middle = seat.y + (seat.height - height) / 2;
  const inward = side === 1 ? seat.x - width - 8 : seat.x + seat.width + 8;
  const candidates = side % 2 ? [[inward, middle], [inward, above], [inward, below]]
    : [[across, side === 0 ? above : below], [seat.x - width - 8, middle], [seat.x + seat.width + 8, middle]];
  const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
  for (const [x, y] of candidates) {
    const result = { x: Math.max(left, Math.min(right - width, x)), y: Math.max(top, Math.min(bottom - height, y)), width, height };
    if (![seat, ...blocked].some(rect => overlaps(result, rect))) return result;
  }
  return null;
}

export class WebglScene {
  readonly device: { version: string; renderer: string; contextAttributes: WebGLContextAttributes | null };
  readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly table: Batch;
  private readonly hand: Batch;
  private readonly tableSlots = emptySlots();
  private readonly handSlots = emptySlots();
  private readonly labels: HTMLElement;
  private readonly labelNodes = new Map<number, HTMLElement>();
  private readonly turnLabel: HTMLElement;
  private readonly actionLabel: HTMLElement;
  private readonly latestLabel: HTMLElement;
  private readonly latestTile: HTMLElement;
  private readonly latestCaption: HTMLElement;
  private readonly meldLabel: HTMLElement;
  private meldToken: string | null = null;
  private meldReduced: boolean | null = null;
  private meldPlacement: { space: string; rect: Rect } | null = null;
  private readonly presentation = new WebglPresentation();
  private currentVisible = new Set<string>();
  private latestEntityId: string | null = null;
  private matrices: [Float32Array, Float32Array] = [new Float32Array(16), new Float32Array(16)];
  private picking: { table: PickBatch; hand: PickBatch; tableSlots: SlotBatch; handSlots: SlotBatch;
    matrices: [Float32Array, Float32Array] } | null = null;
  private pending: { sync: WebGLSync; commit: SceneCommit } | null = null;
  committed: SceneCommit | null = null;
  pan: [number, number] = [0, 0];
  drawCount = 0;
  readonly style: { version: string; verticesPerInstance: number; trianglesPerInstance: number;
    riverCount: number; renderedInstances: number; submittedTriangles: number; frameDrawCalls: number };
  private disposed = false;

  static async create(canvas: HTMLCanvasElement): Promise<WebglScene> {
    const images = await Promise.all(faceAtlases.map(url => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(Error('Required owned tile artwork could not load; no placeholder atlas was substituted.'));
      image.src = url;
    })));
    try { return new WebglScene(canvas, images); }
    catch (error) {
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      throw error;
    }
  }

  private readonly atlases: [WebGLTexture, WebGLTexture];
  private constructor(private readonly canvas: HTMLCanvasElement, images: HTMLImageElement[]) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: false });
    if (!gl) throw Error('WebGL2 is unavailable. No alternate renderer was started.');
    this.gl = gl;
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 1536) throw Error('WebGL texture limits cannot hold the tile atlas.');
    this.device = { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER), contextAttributes: gl.getContextAttributes() };
    this.program = compileProgram(gl, TILE_INSTANCE_VS, fragment);
    this.atlases = [this.atlas(images[0]), this.atlas(images[1])];
    this.texture = this.atlases[0];
    const geometry = beveledTileGeometry();
    this.table = { mesh: createTileMesh(gl, this.program, capacity, geometry), targets: [] };
    this.hand = { mesh: createTileMesh(gl, this.program, capacity, geometry), targets: [] };
    this.style = { version: 'cohesive-teal-table-v3', verticesPerInstance: geometry.positions.length / 3,
      trianglesPerInstance: geometry.indices.length / 3, riverCount: 0, renderedInstances: 0, submittedTriangles: 0, frameDrawCalls: 0 };
    this.labels = document.createElement('div');
    this.labels.className = 'webgl-labels';
    this.labels.setAttribute('aria-label', 'Table turn and public moves');
    this.turnLabel = document.createElement('span');
    this.turnLabel.className = 'webgl-turn';
    this.turnLabel.hidden = true;
    this.actionLabel = document.createElement('span');
    this.actionLabel.className = 'webgl-action';
    this.actionLabel.hidden = true;
    this.latestLabel = document.createElement('div');
    this.latestLabel.className = 'webgl-latest';
    this.latestLabel.hidden = true;
    this.latestLabel.setAttribute('role', 'status');
    this.latestLabel.setAttribute('aria-live', 'polite');
    this.latestTile = document.createElement('span');
    this.latestTile.className = 'webgl-latest-tile';
    this.latestTile.setAttribute('aria-hidden', 'true');
    this.latestCaption = document.createElement('span');
    this.latestCaption.className = 'webgl-latest-caption';
    this.latestLabel.append(this.latestTile, this.latestCaption);
    this.meldLabel = document.createElement('span');
    this.meldLabel.className = 'webgl-meld-callout';
    this.meldLabel.hidden = true;
    this.meldLabel.setAttribute('role', 'status');
    this.meldLabel.setAttribute('aria-live', 'polite');
    this.labels.append(this.turnLabel, this.actionLabel, this.latestLabel, this.meldLabel);
    canvas.parentElement!.append(this.labels);
    this.check();
  }

  private atlas(image: HTMLImageElement): WebGLTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1536; canvas.height = 768;
    const context = canvas.getContext('2d');
    if (!context) throw Error('Tile texture composition is unavailable.');
    const colors: Record<number, string> = {
      37: '#216c76', 38: '#ad7639', 39: '#f7f3e6', 40: '#176a67', 41: '#103d45',
      42: '#ffd36e', 43: '#60d9da', 44: '#a43e44', 58: '#205d53', 59: '#c4aa57', 60: '#0b4046',
      62: '#186b66', 63: '#287b75',
    };
    for (let row = 0; row < 64; row++) for (let side = 0; side < 3; side++) {
      const x = ((row % 8) * 3 + side) * 64, y = Math.floor(row / 8) * 96;
      const surface = row < 40 ? tileSurface(row, side) : null;
      context.fillStyle = surface?.base ?? colors[row] ?? '#f7f3e6';
      context.fillRect(x, y, 64, 96);
      if (surface?.cap) {
        const gradient = context.createLinearGradient(x, y + 4, x, y + 92);
        gradient.addColorStop(0, surface.cap.top); gradient.addColorStop(1, surface.cap.bottom);
        context.fillStyle = gradient; context.strokeStyle = surface.cap.edge; context.lineWidth = 1;
        context.beginPath(); context.roundRect(x + 3, y + 4, 58, 88, 3);
        context.fill(); context.stroke();
      }
      if (surface?.face !== null && surface?.face !== undefined) {
        const face = surface.face;
        context.drawImage(image, face % 8 * 192, 1536 - (Math.floor(face / 8) + 1) * 288, 192, 288, x, y, 64, 96);
      }
      if (row >= 45 && row <= 51 && side === 0) {
        context.fillStyle = row === 50 ? '#a42e38' : '#172c3a';
        context.font = `bold ${row === 51 ? 16 : 12}px sans-serif`;
        context.textAlign = 'center'; context.textBaseline = 'middle';
        context.fillText(['100', '500', '1000', '5000', '10000', '-10000', 'EAST'][row - 45], x + 32, y + 48);
      }
      if (row >= 52 && row <= 57 && side === 0) {
        const n = row - 51, positions = [[.25, .25], [.75, .75], [.25, .75], [.75, .25], [.25, .5], [.75, .5]];
        if (n % 2) positions.unshift([.5, .5]);
        const pips = n === 1 ? positions.slice(0, 1) : positions.slice(n % 2 ? 1 : 0, (n % 2 ? 1 : 0) + n - n % 2)
          .concat(n % 2 ? [[.5, .5]] : []);
        context.fillStyle = n === 1 ? '#a42e38' : '#172c3a';
        for (const [px, py] of pips) { context.beginPath(); context.arc(x + px * 64, y + py * 96, 6, 0, Math.PI * 2); context.fill(); }
      }
    }
    const gl = this.gl, texture = gl.createTexture();
    if (!texture) throw Error('GPU texture allocation failed.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  draw(layout: Layout, frame: Frame, viewport: Viewport): void {
    if (this.disposed || this.pending) throw Error('Overlapping or disposed WebGL publication.');
    const started = performance.now(), gl = this.gl;
    this.reconcile(frame);
    const plan = buildWebglPlan(layout, frame, viewport);
    const cue = this.presentation.apply(plan, frame, viewport, started);
    const discardId = this.presentation.latestDiscardId;
    this.matrices = [fittedCamera(plan, frame, false, this.pan), fittedCamera(plan, frame, true)];
    for (const batch of [this.table, this.hand]) { batch.mesh.instanceCount = 0; batch.targets.length = 0; }
    for (const batch of [this.tableSlots, this.handSlots]) { batch.instanceCount = 0; batch.names.length = 0; }
    const push = (batch: Batch, model: Float32Array, row: number, target: Target | null = null): void => {
      const index = batch.mesh.instanceCount;
      setTileInstance(batch.mesh, index, model, row);
      batch.targets[index] = target;
    };
    const midpoint = plan.bounds.getCenter(new Vector3()), dimensions = plan.bounds.getSize(new Vector3());
    push(this.table, solidPose(midpoint.x, -.03, midpoint.z, dimensions.x + .06, .05, dimensions.z + .06), 41);
    push(this.table, solidPose(midpoint.x, -.008, midpoint.z, dimensions.x + .035, .012, dimensions.z + .035), 60);
    push(this.table, solidPose(midpoint.x, TABLE_FELT_Y - .004, midpoint.z, dimensions.x, .008, dimensions.z), 40);
    for (const side of [-1, 1]) {
      const x = midpoint.x + side * (dimensions.x / 2 + .015);
      const z = midpoint.z + side * (dimensions.z / 2 + .015);
      push(this.table, solidPose(x, .0035, midpoint.z, .030, .029, dimensions.z + .060), 41);
      push(this.table, solidPose(midpoint.x, .0035, z, dimensions.x + .060, .029, .030), 41);
      push(this.table, solidPose(x, .0183, midpoint.z, .0013, .0003, dimensions.z + .030), 59);
      push(this.table, solidPose(midpoint.x, .0183, z, dimensions.x + .030, .0003, .0013), 59);
    }
    for (const river of plan.rivers.values()) {
      const position = river.getCenter(new Vector3()), extent = river.getSize(new Vector3());
      push(this.table, solidPose(position.x, position.y, position.z, extent.x, .0001, extent.z), 63);
      push(this.table, solidPose(position.x, position.y + .0001, position.z, Math.max(.001, extent.x - .004), .0001,
        Math.max(.001, extent.z - .004)), 62);
    }
    const plate = Math.max(.14, Math.min(.16, plan.centerSize));
    push(this.table, solidPose(0, -.003, 0, plate + .006, .004, plate + .006), 63);
    push(this.table, solidPose(0, -.001, 0, plate, .0005, plate), 60);
    for (const placement of plan.entities.values()) {
      const { entity, pose, separate } = placement, batch = separate ? this.hand : this.table;
      const model = tileModel(pose, entity.kind);
      const row = tileMaterialId(entity);
      if (entity.kind === 'TILE') {
        const halfY = Math.abs(model[1]) * .5 + Math.abs(model[5]) * TILE_HEIGHT / 2 + Math.abs(model[9]) * TILE_DEPTH / 2;
        const width = Math.abs(model[0]) + Math.abs(model[4]) * TILE_HEIGHT + Math.abs(model[8]) * TILE_DEPTH;
        const depth = Math.abs(model[2]) + Math.abs(model[6]) * TILE_HEIGHT + Math.abs(model[10]) * TILE_DEPTH;
        const lift = Math.max(0, pose.position.y - halfY), surface = separate ? -.0005 : TABLE_SHADOW_Y;
        push(batch, solidPose(pose.position.x + lift * .25, surface, pose.position.z + lift * .33,
          width * 1.24, .00005, depth * 1.24), 61 + Math.max(.025, .07 - lift * .25));
        push(batch, solidPose(pose.position.x, surface + .0001, pose.position.z,
          width * 1.06, .00005, depth * 1.06), 61 + Math.max(.035, .12 - lift * .9));
      }
      const pickup = frame.pickup?.canTake && frame.pickup.batchPreviewSlotNames.includes(entity.slotName);
      const latest = cue?.entityId === entity.entityId;
      const lastDiscard = discardId === entity.entityId;
      if (latest || lastDiscard || entity.display.selected || entity.display.hovered || entity.display.highlight > 0 || entity.display.drawn || pickup) {
        const border = new Matrix4().fromArray(model).multiply(new Matrix4().makeScale(latest ? 1.22 : 1.10, latest ? 1.16 : 1.06, .3));
        push(batch, Float32Array.from(border.elements), latest || lastDiscard || entity.display.selected || pickup ? 42 : 43);
      }
      push(batch, model, row, { kind: 'entity', id: entity.entityId });
    }
    const occupied = new Set(frame.entities.map(entity => entity.slotName));
    const dragging = frame.entities.some(entity => entity.display.held);
    for (const [name, placement] of plan.slots) {
      const pose = placement.poses[placement.slot.shadowRotationIndex] ?? placement.poses[0];
      if (!pose) continue;
      const batch = placement.separate ? this.handSlots : this.tableSlots;
      if (batch.instanceCount >= capacity) throw Error('Slot picking capacity exceeded.');
      batch.modelData.set(tileModel(pose, placement.slot.kind), batch.instanceCount * 16);
      batch.names[batch.instanceCount++] = name;
      if (!occupied.has(name) && placement.slot.drawShadow
        && (dragging || frame.pickup?.batchPreviewSlotNames.includes(name))) {
        const shadow: RenderPose = { position: pose.position.clone(), rotation: pose.rotation, scale: pose.scale };
        shadow.position.y = TABLE_SHADOW_Y;
        const model = new Matrix4().fromArray(tileModel(shadow, placement.slot.kind)).multiply(new Matrix4().makeScale(1, 1, .035));
        push(placement.separate ? this.hand : this.table, Float32Array.from(model.elements),
          frame.pickup?.batchPreviewSlotNames.includes(name) ? 59 : 58);
      }
    }
    if (frame.dice) for (let i = 0; i < 2; i++) {
      push(this.table, solidPose((i ? 1 : -1) * .035, .028, 0, .055, .055, .055),
        51 + frame.dice.values[i], frame.dice.canRoll ? { kind: 'dice', id: null } : null);
    }
    gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(.025, .11, .13, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program); gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlases[frame.presentation.tileLabels ? 1 : 0] ?? this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_atlas'), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_atlasGrid'), 24, 8);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_lightDir'), -.3, 1, .4);
    const drawCount = this.drawCount;
    this.drawBatch(this.table, plan.board, this.matrices[0], viewport);
    if (plan.hand.height > 0) this.drawBatch(this.hand, plan.hand, this.matrices[1], viewport);
    this.style.riverCount = plan.rivers.size;
    this.style.renderedInstances = this.table.mesh.instanceCount + this.hand.mesh.instanceCount;
    this.style.submittedTriangles = this.style.renderedInstances * this.style.trianglesPerInstance;
    this.style.frameDrawCalls = this.drawCount - drawCount;
    gl.disable(gl.SCISSOR_TEST);
    this.check();
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw Error('GPU frame fence allocation failed.');
    gl.flush();
    this.pending = { sync, commit: { frame, plan, viewport, cue, discardId, meldCallout: this.presentation.meldCallout,
      milliseconds: performance.now() - started } };
  }

  private drawBatch(batch: Batch, rect: Rect, matrix: Float32Array, viewport: Viewport): void {
    const gl = this.gl, ratio = viewport.renderPixelRatio;
    const x = Math.round(rect.x * ratio), y = Math.round((viewport.heightCssPx - rect.y - rect.height) * ratio);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, width, height); gl.viewport(x, y, width, height);
    gl.clearColor(.025, .11, .13, 1); gl.clear(gl.DEPTH_BUFFER_BIT | (batch === this.hand ? gl.COLOR_BUFFER_BIT : 0));
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_viewProj'), false, matrix);
    const inverse = new Matrix4().fromArray(matrix).invert();
    const near = new Vector3(0, 0, -1).applyMatrix4(inverse), far = new Vector3(0, 0, 1).applyMatrix4(inverse);
    const eye = near.clone().addScaledVector(near.clone().sub(far).normalize(), .01);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_eye'), eye.x, eye.y, eye.z);
    uploadTileInstances(gl, batch.mesh); drawTileMesh(gl, batch.mesh); this.drawCount++;
  }

  poll(): SceneCommit | null {
    if (!this.pending) return null;
    const gl = this.gl, { sync, commit } = this.pending;
    this.check();
    const result = gl.clientWaitSync(sync, 0, 0);
    if (result === gl.TIMEOUT_EXPIRED) return null;
    if (result === gl.WAIT_FAILED) throw Error('GPU frame fence failed.');
    gl.deleteSync(sync); this.pending = null;
    this.committed = commit;
    const snapshot = (batch: Batch): PickBatch => pickableModels(batch.mesh.modelData, batch.targets, batch.mesh.instanceCount);
    const slots = (batch: SlotBatch): SlotBatch => ({ modelData: batch.modelData.slice(0, batch.instanceCount * 16),
      instanceCount: batch.instanceCount, names: batch.names.slice() });
    this.picking = { table: snapshot(this.table), hand: snapshot(this.hand), tableSlots: slots(this.tableSlots),
      handSlots: slots(this.handSlots), matrices: this.matrices };
    this.updateLabels(commit);
    return commit;
  }

  cancelPending(): void {
    if (this.pending) this.gl.deleteSync(this.pending.sync);
    this.pending = null;
  }

  resetPresentation(): void {
    this.presentation.clear(); this.latestLabel.hidden = this.actionLabel.hidden = true; this.hideMeld(true);
  }

  reconcile(frame: Frame): void {
    this.presentation.reconcile(frame);
    if (!this.presentation.meldCallout) this.hideMeld(true);
    this.currentVisible = new Set(frame.entities.filter(entity => entity.appearance.showFace
      && entity.appearance.knownFace && entity.appearance.faceIndex !== null).map(entity => entity.entityId));
    if (this.latestEntityId && !this.currentVisible.has(this.latestEntityId)) {
      this.latestLabel.hidden = true; this.latestTile.style.backgroundImage = 'none'; this.latestEntityId = null;
    }
  }

  pick(x: number, y: number, touch = false): Target | null {
    const commit = this.committed;
    if (!commit || !this.picking) return null;
    const hand = contains(commit.plan.hand, x, y), rect = hand ? commit.plan.hand : commit.plan.board;
    if (!contains(rect, x, y)) return null;
    const batch = hand ? this.picking.hand : this.picking.table, matrix = this.picking.matrices[hand ? 1 : 0];
    const hit = pickTile(batch, pickRay(rect, x, y, matrix));
    if (hit && batch.targets[hit.instanceIndex]) return batch.targets[hit.instanceIndex];
    if (!touch) return null;
    let nearest: Target | null = null, distance = 22 * 22;
    for (const placement of commit.plan.entities.values()) {
      if (placement.separate !== hand || !Object.values(placement.entity.interaction).some(Boolean)) continue;
      const point = this.project(placement.entity.entityId);
      if (!point) continue;
      const d = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (d < distance) { distance = d; nearest = { kind: 'entity', id: placement.entity.entityId }; }
    }
    return nearest;
  }

  pickSlot(x: number, y: number): string | null {
    const commit = this.committed;
    if (!commit || !this.picking) return null;
    const hand = contains(commit.plan.hand, x, y), rect = hand ? commit.plan.hand : commit.plan.board;
    if (!contains(rect, x, y)) return null;
    const batch = hand ? this.picking.handSlots : this.picking.tableSlots;
    const hit = pickTile(batch, pickRay(rect, x, y, this.picking.matrices[hand ? 1 : 0]));
    return hit ? batch.names[hit.instanceIndex] : null;
  }

  project(entityId: string): { x: number; y: number; separate: boolean } | null {
    const commit = this.committed, placement = commit?.plan.entities.get(entityId);
    if (!commit || !placement || !this.picking) return null;
    const rect = placement.separate ? commit.plan.hand : commit.plan.board;
    const point = placement.pose.position.clone(); point.z *= -1;
    point.applyMatrix4(new Matrix4().fromArray(this.picking.matrices[placement.separate ? 1 : 0]));
    if (point.z < -1 || point.z > 1) return null;
    return { x: rect.x + (point.x + 1) * rect.width / 2, y: rect.y + (1 - point.y) * rect.height / 2, separate: placement.separate };
  }

  projectSlot(slotName: string): { x: number; y: number } | null {
    const commit = this.committed, placement = commit?.plan.slots.get(slotName);
    if (!commit || !placement || !this.picking) return null;
    const pose = placement.poses[placement.slot.shadowRotationIndex] ?? placement.poses[0];
    if (!pose) return null;
    const rect = placement.separate ? commit.plan.hand : commit.plan.board;
    const point = pose.position.clone(); point.z *= -1;
    point.applyMatrix4(new Matrix4().fromArray(this.picking.matrices[placement.separate ? 1 : 0]));
    return { x: rect.x + (point.x + 1) * rect.width / 2, y: rect.y + (1 - point.y) * rect.height / 2 };
  }

  private updateLabels(commit: SceneCommit): void {
    const { frame, plan } = commit;
    const rect = plan.board;
    const point = new Vector3().applyMatrix4(new Matrix4().fromArray(this.matrices[0]));
    const x = rect.x + (point.x + 1) * rect.width / 2, y = rect.y + (1 - point.y) * rect.height / 2;
    const active = frame.turn?.activeSeat;
    const phase = frame.turn?.phase;
    const phaseLabel = phase === 'AwaitingDiscard' ? t(active === frame.session.actorSeat ? 'table.your_turn' : 'table.to_discard')
      : phase === 'AwaitingClaim' ? t('table.claims_open') : phase ? phase.replace(/([a-z])([A-Z0-9])/g, '$1 $2') : t('table.waiting');
    const turnText = `${active === null || active === undefined ? '◇' : ['E', 'S', 'W', 'N'][active]} · ${phaseLabel}`;
    this.turnLabel.hidden = !frame.session.snapshotReady;
    if (this.turnLabel.textContent !== turnText) this.turnLabel.textContent = turnText;
    this.turnLabel.style.left = `${x}px`; this.turnLabel.style.top = `${y - 14}px`;
    this.turnLabel.dataset.local = String(active !== null && active !== undefined && active === frame.session.actorSeat);
    const cue = commit.cue, latest = commit.discardId ? plan.entities.get(commit.discardId)?.entity : null;
    const spacious = rect.width / rect.height >= 1.8 && rect.height >= 180;
    this.actionLabel.hidden = !cue || !spacious;
    if (cue) {
      const action = `${cue.seat === null ? '' : `${['E', 'S', 'W', 'N'][cue.seat]} · `}${t(`table.${cue.kind}`)}`;
      if (this.actionLabel.textContent !== action) this.actionLabel.textContent = action;
      this.actionLabel.style.left = `${x}px`;
      this.actionLabel.style.top = `${Math.max(rect.y + 4, Math.min(rect.y + rect.height - 24, y + 12))}px`;
    }
    if (latest && this.currentVisible.has(latest.entityId) && latest.group === 'discard' && latest.appearance.showFace
      && latest.appearance.knownFace && latest.appearance.faceIndex !== null) {
      const face = latest.appearance.faceIndex;
      this.latestLabel.hidden = !spacious; this.latestEntityId = latest.entityId;
      this.latestLabel.dataset.accented = String(cue?.kind === 'discard' && cue.entityId === latest.entityId);
      this.latestLabel.style.left = `${x}px`;
      this.latestLabel.style.top = `${Math.max(rect.y + 4, Math.min(rect.y + rect.height - 60, y + 36))}px`;
      this.latestTile.style.backgroundImage = `url("${faceAtlases[frame.presentation.tileLabels ? 1 : 0]}")`;
      this.latestTile.style.backgroundPosition = `${face % 8 / 7 * 100}% ${(1536 - (Math.floor(face / 8) + 1) * 288) / 1248 * 100}%`;
      const caption = `${latest.seat === null ? '' : `${['E', 'S', 'W', 'N'][latest.seat]} · `}${t('table.last_discard')}`;
      if (this.latestCaption.textContent !== caption) this.latestCaption.textContent = caption;
      const name = face < 27 ? t('hand.tile', { rank: face % 9 + 1, suit: t(`hand.suit_${Math.floor(face / 9)}`) }) : t('table.public_tile');
      const label = `${caption}: ${name}`;
      if (this.latestLabel.getAttribute('aria-label') !== label) this.latestLabel.setAttribute('aria-label', label);
    } else { this.latestLabel.hidden = true; this.latestEntityId = null; this.latestTile.style.backgroundImage = 'none'; }
    const present = new Set<number>();
    const obstacles = [...plan.groups.values(), ...plan.rivers.values()]
      .map(bounds => projectTableBounds(bounds, rect, this.matrices[0]));
    if (plan.compact) {
      // Reserve public reveal routes even at rest: the canvas can paint before poll moves DOM badges.
      const midpoint = plan.bounds.getCenter(new Vector3()), extent = plan.bounds.getSize(new Vector3());
      const anchors = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (const [seat, river] of plan.rivers) {
        const side = (seat - (frame.session.viewSeat ?? 0) + 4) % 4;
        const route = river.clone().expandByPoint(new Vector3(
          midpoint.x + anchors[side][0] * extent.x * .43, plan.bounds.max.y + .06,
          midpoint.z + anchors[side][1] * extent.z * .43)).expandByScalar(.06);
        obstacles.push(projectTableBounds(route, rect, this.matrices[0]));
      }
    }
    // Settled groups exclude travel; also protect the meshes displayed by this completed frame.
    const camera = new Matrix4().fromArray(this.matrices[0]);
    for (const { entity, pose, separate } of plan.entities.values()) {
      if (separate) continue;
      const matrix = camera.clone().multiply(new Matrix4().fromArray(tileModel(pose, entity.kind)));
      const points: Vector3[] = [];
      for (const x of [-TILE_WIDTH / 2, TILE_WIDTH / 2]) for (const y of [-TILE_HEIGHT / 2, TILE_HEIGHT / 2])
        for (const z of [-TILE_DEPTH / 2, TILE_DEPTH / 2]) points.push(new Vector3(x, y, z).applyMatrix4(matrix));
      const xs = points.map(point => rect.x + (point.x + 1) * rect.width / 2);
      const ys = points.map(point => rect.y + (1 - point.y) * rect.height / 2);
      obstacles.push({ x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
    for (const seat of frame.seats) {
      present.add(seat.seat);
      let node = this.labelNodes.get(seat.seat);
      if (!node) {
        node = document.createElement('span'); this.labelNodes.set(seat.seat, node); this.labels.append(node);
      }
      const relative = (seat.seat - (frame.session.viewSeat ?? 0) + 4) % 4;
      const action = cue?.seat === seat.seat ? `${t(`table.${cue.kind}`)} · ` : '';
      const text = `${['E', 'S', 'W', 'N'][seat.seat]} · ${action}${seat.nick ?? `Seat ${seat.seat + 1}`}${seat.score === null ? '' : ` · ${seat.score}`}`;
      if (node.textContent !== text) node.textContent = text;
      node.dataset.side = String(relative);
      node.className = `${active === seat.seat ? 'webgl-seat active' : 'webgl-seat'}${commit.cue?.sourceSeat === seat.seat ? ' played' : ''}`;
      node.style.maxWidth = `min(9rem, ${rect.width * .19}px)`;
      const hand = new Box3();
      for (const group of ['hand', 'meld']) {
        const bounds = plan.groups.get(`${seat.seat}:${group}`);
        if (bounds) hand.union(bounds);
      }
      const label = seatLabelRect(rect, hand.isEmpty() ? null : projectTableBounds(hand, rect, this.matrices[0]),
        relative, node.offsetWidth, node.offsetHeight, obstacles);
      node.style.left = `${label.x + (relative === 1 || relative === 2 ? label.width : 0)}px`;
      node.style.top = `${label.y + label.height / 2}px`;
      obstacles.push(label);
    }
    for (const [seat, node] of this.labelNodes) if (!present.has(seat)) { node.remove(); this.labelNodes.delete(seat); }
    this.updateMeldCallout(commit);
  }

  private hideMeld(reset = false): void {
    this.meldLabel.hidden = true;
    if (reset) {
      this.meldLabel.replaceChildren(); this.meldToken = null; this.meldReduced = null; this.meldPlacement = null;
    }
  }

  private handObstacles(commit: SceneCommit): Rect[] {
    return commit.frame.localHand.entityIds.flatMap(id => {
      const placement = commit.plan.entities.get(id);
      if (!placement) return [];
      const rect = placement.separate ? commit.plan.hand : commit.plan.board;
      const matrix = new Matrix4().fromArray(this.matrices[placement.separate ? 1 : 0])
        .multiply(new Matrix4().fromArray(tileModel(placement.pose)));
      const points: Vector3[] = [];
      for (const x of [-TILE_WIDTH / 2, TILE_WIDTH / 2]) for (const y of [-TILE_HEIGHT / 2, TILE_HEIGHT / 2])
        for (const z of [-TILE_DEPTH / 2, TILE_DEPTH / 2]) points.push(new Vector3(x, y, z).applyMatrix4(matrix));
      const xs = points.map(point => rect.x + (point.x + 1) * rect.width / 2);
      const ys = points.map(point => rect.y + (1 - point.y) * rect.height / 2);
      return [{ x: Math.min(...xs) - 3, y: Math.min(...ys) - 3,
        width: Math.max(...xs) - Math.min(...xs) + 6, height: Math.max(...ys) - Math.min(...ys) + 6 }];
    });
  }

  private updateMeldCallout(commit: SceneCommit): void {
    const callout = commit.meldCallout, now = performance.now();
    if (!callout || callout !== this.presentation.meldCallout || now >= callout.until) { this.hideMeld(true); return; }
    const seat = this.labelNodes.get(callout.seat);
    if (!seat) { this.hideMeld(); return; }
    const canvas = this.canvas.getBoundingClientRect(), visual = window.visualViewport;
    const local = (rect: DOMRect): Rect =>
      ({ x: rect.left - canvas.left, y: rect.top - canvas.top, width: rect.width, height: rect.height });
    const visible = {
      x: (visual?.offsetLeft ?? 0) - canvas.left, y: (visual?.offsetTop ?? 0) - canvas.top,
      width: visual?.width ?? window.innerWidth ?? commit.viewport.widthCssPx,
      height: visual?.height ?? window.innerHeight ?? commit.viewport.heightCssPx,
    };
    const showing = (node: Element): boolean => {
      const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    };
    if ([...document.querySelectorAll('.modal.show, dialog[open]')].some(showing)) { this.hideMeld(); return; }
    const blocked = ['claim-window-actions', 'own-turn-actions', 'pickup-hud'].flatMap(id => {
      const node = document.getElementById(id);
      return node && !node.hidden && showing(node) ? [local(node.getBoundingClientRect())] : [];
    });
    blocked.push(...this.handObstacles(commit));
    const token = `${commit.frame.sessionId}:${callout.key}:${callout.seat}:${callout.kind}:${callout.started}:${callout.until}`;
    const fresh = token !== this.meldToken, wasHidden = this.meldLabel.hidden;
    if (fresh) {
      const word = document.createElement('span');
      word.className = 'webgl-meld-word'; word.textContent = t(`table.callout_${callout.kind}`);
      this.meldLabel.replaceChildren(word);
      this.meldLabel.setAttribute('aria-label', `${['E', 'S', 'W', 'N'][callout.seat]} · ${word.textContent}`);
      this.meldToken = token;
    }
    const reduced = isReducedMotionActive();
    if (fresh || wasHidden || reduced !== this.meldReduced) {
      this.meldLabel.style.setProperty('--meld-delay', `${-Math.max(0, now - callout.started)}ms`);
      this.meldLabel.dataset.reduced = String(reduced); this.meldReduced = reduced;
    }
    this.meldLabel.style.setProperty('--meld-max-width', `${Math.max(0, Math.min(commit.plan.board.width, visible.width) - 12)}px`);
    this.meldLabel.hidden = false;
    const side = (callout.seat - (commit.frame.session.viewSeat ?? 0) + 4) % 4;
    const { frame, plan, viewport } = commit, width = this.meldLabel.offsetWidth, height = this.meldLabel.offsetHeight;
    const space = JSON.stringify([token, frame.instanceId, frame.layoutRevision,
      frame.session.gameId, frame.session.mode, frame.session.actorSeat, frame.session.viewSeat, frame.session.viewerRevision,
      viewport.instanceId, viewport.resizeRevision, canvas.left, canvas.top, canvas.width, canvas.height,
      plan.board.x, plan.board.y, plan.board.width, plan.board.height,
      visible.x, visible.y, visible.width, visible.height, width, height]);
    // Seat text includes short-lived move cues; its changing width must not move one accepted callout.
    let rect = this.meldPlacement?.space === space ? this.meldPlacement.rect : null;
    if (!rect) {
      rect = meldCalloutRect(plan.board, local(seat.getBoundingClientRect()), side, width, height, visible, blocked);
      if (rect) this.meldPlacement = { space, rect };
    }
    if (!rect) { this.hideMeld(); return; }
    const placed = rect;
    if (blocked.some(obstacle => placed.x < obstacle.x + obstacle.width && placed.x + placed.width > obstacle.x
      && placed.y < obstacle.y + obstacle.height && placed.y + placed.height > obstacle.y)) { this.hideMeld(); return; }
    this.meldLabel.style.left = `${rect.x}px`; this.meldLabel.style.top = `${rect.y}px`;
  }

  clear(): void {
    this.presentation.clear(); this.currentVisible.clear(); this.latestEntityId = null;
    this.hideMeld(true);
    this.cancelPending(); this.committed = null; this.picking = null;
    this.table.mesh.instanceCount = 0; this.hand.mesh.instanceCount = 0;
    this.table.targets.length = 0; this.hand.targets.length = 0;
    this.latestLabel.hidden = this.actionLabel.hidden = this.turnLabel.hidden = true;
    this.latestTile.style.backgroundImage = 'none'; this.turnLabel.textContent = '';
    for (const node of this.labelNodes.values()) node.remove();
    this.labelNodes.clear();
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST); gl.clearColor(.025, .11, .13, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  private check(): void {
    if (this.gl.isContextLost() || this.gl.getError() !== this.gl.NO_ERROR) throw Error('WebGL context or GPU operation failed.');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancelPending(); this.committed = null; this.picking = null;
    this.presentation.clear(); this.currentVisible.clear(); this.meldPlacement = null;
    disposeTileMesh(this.gl, this.table.mesh); disposeTileMesh(this.gl, this.hand.mesh);
    for (const texture of this.atlases) this.gl.deleteTexture(texture);
    this.gl.deleteProgram(this.program); this.labels.remove(); this.labelNodes.clear();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
