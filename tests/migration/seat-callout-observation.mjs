import assert from 'node:assert/strict';

// Serialized into the browser; this reads existing public DOM/committed geometry only.
export function readSeatCallout(scene, selector) {
  const rect = node => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const visible = node => {
    const style = getComputedStyle(node), r = node.getBoundingClientRect();
    return !node.hidden && r.width > 0 && r.height > 0 && style.visibility !== 'hidden'
      && style.display !== 'none' && Number(style.opacity) > 0;
  };
  const nodes = [...document.querySelectorAll(selector)].filter(visible);
  if (!nodes.length) return null;
  const node = nodes[0], box = rect(node), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const word = node.querySelector(':scope > .webgl-meld-word') ?? node;
  const committed = scene.committed.meldCallout;
  const anchors = [...(scene.labelNodes?.entries() ?? [])].filter(([, label]) => visible(label))
    .map(([seat, label]) => {
      const r = rect(label);
      return { seat, side: Number(label.dataset.side),
        distance: Math.hypot(x - r.x - r.width / 2, y - r.y - r.height / 2) };
    }).sort((a, b) => a.distance - b.distance);
  const board = scene.committed.plan.board;
  const edges = [Math.abs(y - board.y - board.height), Math.abs(x - board.x - board.width),
    Math.abs(y - board.y), Math.abs(x - board.x)];
  const buttons = [...new Set(document.querySelectorAll('.browser-toolbar > button,#lobby-toggle,#settings-button,#new-game'))]
    .filter(visible).map(button => {
      const r = rect(button);
      return { id: button.id, reachable: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === button };
    });
  const view = visualViewport;
  return { text: word.textContent.trim(), ariaLabel: node.getAttribute('aria-label'), count: nodes.length, rect: box,
    reduced: node.getAttribute('data-reduced'),
    rendered: committed ? { key: committed.key, seat: committed.seat, kind: committed.kind,
      started: committed.started, until: committed.until } : null,
    publicMelds: scene.committed.frame.entities.filter(entity => entity.kind === 'TILE'
      && entity.group === 'meld' && entity.seat === committed?.seat).map(entity => ({
      entityId: entity.entityId, seat: entity.seat, slotName: entity.slotName, indexes: entity.indexes.slice(),
      showFace: entity.appearance.showFace, faceIndex: entity.appearance.showFace
        && entity.appearance.knownFace ? entity.appearance.faceIndex : null,
    })),
    closestSeat: anchors[0]?.seat ?? null, closestBoardSide: edges.indexOf(Math.min(...edges)),
    anchors, pointerEvents: getComputedStyle(node).pointerEvents,
    interceptsPointer: node.contains(document.elementFromPoint(x, y)), controls: buttons,
    inBounds: box.x >= view.offsetLeft - 1 && box.y >= view.offsetTop - 1
      && box.right <= view.offsetLeft + view.width + 1 && box.bottom <= view.offsetTop + view.height + 1,
    runningAnimations: node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running'
      && Number(animation.effect?.getTiming().duration) > 1).length };
}

export function qualifySeatCallout(trace, expected, fullSnapshots, reduced) {
  const meld = trace.moves.find(move => move.kind === 'meld' && move.seat === expected.seat);
  assert(meld, 'The fixture must produce a real accepted public meld for the expected owner');
  const next = trace.moves.find(move => move.kind === 'meld' && move.at > meld.at);
  assert(!next || next.at >= meld.at + 1500, 'Fixture meld is superseded too soon to qualify its expiry; obtain a quiet accepted fixture');
  const end = Math.min(next?.at ?? Infinity, meld.at + 1800);
  const frames = trace.frames.filter(frame => frame.at >= meld.at && frame.at < end
    && frame.sessionId === meld.sessionId && frame.frameId >= meld.frameId);
  const shown = frames.filter(frame => frame.cue?.callout);
  assert(shown.length >= 3, 'No readable callout was actually GPU-correlated with the accepted public meld');
  const first = shown[0], last = shown.at(-1);
  assert(first.at - meld.at <= 300, 'The comic callout must begin with the accepted meld, not a later unrelated draw');
  assert(last.at - first.at >= 750, 'The separate comic callout must remain readable beyond the old 650ms cue');
  assert(last.at - first.at <= 1400, 'The comic callout must be bounded and must not restart on draw/FULL');
  assert(frames.some(frame => frame.at >= meld.at + 1500 && !frame.cue?.callout),
    'An actual later GPU publication must show the comic callout expired');
  const word = new RegExp(`\\b${expected.word}\\b`, 'i');
  const identity = first.cue.callout.rendered;
  assert(identity && Number.isFinite(identity.started) && Number.isFinite(identity.until)
    && identity.until > identity.started, 'Use the actual GPU-committed comic lifecycle, not pending presentation state');
  for (const frame of shown) {
    const badge = frame.cue.callout;
    assert.equal(badge.count, 1, 'Keep a bounded single comic callout, not an accumulating animation queue');
    assert(word.test(`${badge.text} ${badge.ariaLabel ?? ''}`), 'The word must match the independent accepted-fixture expectation');
    assert.equal(badge.rendered?.seat, meld.seat, 'The committed comic owner must equal the accepted public meld owner');
    assert.equal(String(badge.rendered?.kind).toLowerCase(), expected.word.toLowerCase());
    assert.deepEqual(badge.rendered, identity, 'Ordinary draws/FULLs must not restart the committed key/start/expiry');
    const owner = badge.anchors.find(anchor => anchor.seat === meld.seat);
    assert(owner && (badge.closestSeat === meld.seat || owner.side === badge.closestBoardSide),
      'The comic label must be near the actual owner anchor/side, not activeSeat or the discarder');
    assert(badge.inBounds, 'The comic label must stay inside the actual phone/desktop visual viewport');
    assert.equal(badge.pointerEvents, 'none');
    assert.equal(badge.interceptsPointer, false);
    assert(badge.controls.length && badge.controls.every(control => control.reachable),
      'Visible game controls must retain their real center-point hit targets');
    if (reduced) {
      assert.equal(badge.reduced, 'true', 'Read the actual reduced-motion callout attribute');
      assert.equal(badge.runningAnimations, 0, 'Reduced-motion comic labels must not travel or pulse');
    }
  }
  const draw = trace.moves.find(move => move.kind === 'draw' && move.at > meld.at && move.at < last.at);
  assert(draw, 'Need a real ordinary draw while the owning-seat badge remains visible');
  assert(shown.some(frame => frame.at >= draw.at && frame.activeSeat !== meld.seat),
    'Prove ownership independently of a subsequently active drawing seat');
  assert(!frames.some(frame => frame.at >= first.at && frame.at <= last.at && !frame.cue?.callout),
    'A draw must not erase and then restart the same comic badge');
  const fulls = fullSnapshots.filter(value => value.epochMilliseconds >= trace.timeOrigin + meld.at + 200
    && value.epochMilliseconds <= trace.timeOrigin + end);
  assert(fulls.length, 'Need an actual later wire FULL, not a fabricated duplicate snapshot or inferred publication');
  for (const frame of trace.frames.filter(frame => frame.at < meld.at)) {
    if (!frame.cue?.callout) continue;
    assert(trace.moves.some(move => move.kind === 'meld' && move.at <= frame.at && frame.at - move.at <= 1500),
      'Initial snapshots or pending actions must not announce an unaccepted meld');
  }
  if (reduced) {
    const boxes = new Set(shown.map(frame => Object.values(frame.cue.callout.rect).map(value => value.toFixed(2)).join(',')));
    assert.equal(boxes.size, 1, 'The reduced-motion badge must remain at one actually rendered placement');
  }
  return { expected, acceptedMeld: meld, distinctVisibleGpuSamples: shown.length,
    observedVisibleMilliseconds: last.at - first.at, drawAt: draw.at, laterWireFulls: fulls.length,
    scope: 'Expected word/owner come from a supplied accepted-game fixture, not a reimplemented meld classifier.' };
}
