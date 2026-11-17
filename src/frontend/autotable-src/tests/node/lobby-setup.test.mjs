import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceLoader, root } from './renderer-test-support.mjs';

const markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/en.json'), 'utf8'));

class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.attributes = new Map(); this.dataset = {}; this.style = {}; this.classes = new Set();
    this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.text = '';
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, on = !this.classes.has(name)) => on ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get parentNode() { return this.parentElement ?? null; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get value() {
    return this.ownValue ?? (this.tagName === 'SELECT'
      ? this.querySelectorAll('option').find(node => node.selected)?.value ?? this.querySelectorAll('option')[0]?.value ?? '' : '');
  }
  set value(value) {
    this.ownValue = String(value);
    if (this.tagName === 'SELECT') this.querySelectorAll('option').forEach(node => { node.selected = node.value === value; });
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
    else if (['id', 'name', 'value', 'type'].includes(name)) this[name] = value;
    else if (['checked', 'disabled', 'hidden', 'open', 'selected'].includes(name)) this[name] = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, reference) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child);
    child.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, child); return child;
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const named = /^(input)\[name="([^"]+)"\](:checked)?$/.exec(selector);
    if (named) return this.tagName === 'INPUT' && this.name === named[2] && (!named[3] || this.checked);
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child, ...child.descendants()]).filter(node => node.matches(selector));
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  focus() { if (this.closest('details')?.open !== false) this.document.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

function fixture({ saved, search = '', preferredVariant } = {}) {
  const document = Object.assign(new EventTarget(), { readyState: 'complete', activeElement: null });
  document.body = new Element('body', document);
  document.documentElement = document.body;
  document.createElement = tag => new Element(tag, document);
  const stack = [document.body];
  const clean = markup.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const match of clean.matchAll(/<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (!match[1]) { stack.at(-1).text += match[3] ?? ''; continue; }
    if (match[0].startsWith('</')) {
      const index = stack.findLastIndex(node => node.tagName.toLowerCase() === match[1].toLowerCase());
      if (index > 0) stack.length = index;
      continue;
    }
    const node = document.createElement(match[1]);
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], attribute[2] ?? '');
    stack.at(-1).appendChild(node);
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(match[1])) stack.push(node);
  }
  const all = [document.body, ...document.body.descendants()];
  const ids = new Map(all.filter(node => node.id).map(node => [node.id, node]));
  // Only setup services are mounted. Unrelated auth/profile/social controllers
  // retain their missing-anchor behavior instead of performing network work.
  const mounted = new Set(['lobby-panel', 'lobby-toggle', 'lobby-apply', 'lobby-close',
    'lobby-deal-mode-fieldset', 'lobby-bot-difficulty-fieldset', 'lobby-spectator-hint',
    'lobby-seed', 'lobby-seed-error', 'lobby-base-unit', 'lobby-base-unit-fieldset',
    'lobby-base-unit-error', 'lobby-base-unit-hint', 'lobby-base-unit-label', 'lobby-base-unit-legend',
    'lobby-save-defaults', 'lobby-advanced', 'lobby-advanced-summary', 'lobby-quick-match']);
  document.getElementById = id => mounted.has(id) || id === 'ferro-variant-select'
    ? ids.get(id) ?? document.body.querySelector(`#${id}`) : null;
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  const storage = new Map(saved ? [['mahjong.lobby.defaults', JSON.stringify(saved)]] : []);
  if (preferredVariant) storage.set('mahjong.preferredVariant', preferredVariant);
  const navigations = [], location = new URL(`http://setup.test/autotable/${search}`);
  location.replace = url => navigations.push(new URL(url, location));
  const window = Object.assign(new EventTarget(), {
    location, localStorage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    requestIdleCallback() {}, setTimeout() {},
  });
  const noop = () => {};
  const loader = sourceLoader({
    window, document, Element, HTMLElement: Element, HTMLInputElement: Element,
    MutationObserver: class { observe() {} disconnect() {} },
  }, {
    'profile.ts': { hydrateProfileFromCacheIfAvailable: noop, onProfile: noop, getProfile: () => null, initProfileHubBindings: noop },
    'identity.ts': { bootstrapIdentity: async () => null, onIdentity: noop, refreshOnboardingVisibility: noop, getVerifiedIdentity: () => null },
    'game-state.ts': { getGameState: () => null, getGameStateStatus: () => ({ status: 'idle' }), subscribeGameState: noop },
    'hub.ts': { hubIsConnected: () => false, onHubStatus: noop },
    'lobby-presence.ts': { startLobbyPresence: async () => {}, getLobbyPresence: () => [], subscribeLobbyPresence: noop },
    'toast.ts': { showToast: noop }, 'theme.ts': { installDisplayPreferences: noop },
    'i18n.ts': { onLanguageChange: noop, t: (key, values = {}) =>
      (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? '')) },
    'ui/dark-listbox.ts': {},
  });
  loader.load('lobby.ts').initLobby();
  const change = (name, value) => {
    const inputs = document.querySelectorAll(`input[name="${name}"]`);
    const chosen = inputs.find(input => input.value === value);
    assert(chosen && !chosen.disabled, `enabled real markup choice ${name}=${value}`);
    inputs.forEach(input => { input.checked = input === chosen; });
    chosen.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const fill = (id, value) => { ids.get(id).value = value; ids.get(id).dispatchEvent(new Event('input')); };
  return { document, ids, loader, storage, navigations, change, fill };
}

test('simple setup uses the real closed disclosure, exposes only variant/bots, and starts with unchanged creation defaults', () => {
  const h = fixture();
  const advanced = h.ids.get('lobby-advanced');
  assert.equal(advanced.open, false);
  for (const id of ['lobby-variant-fieldset', 'lobby-bot-count-fieldset', 'lobby-apply']) assert.equal(h.ids.get(id).closest('details'), null, id);
  for (const id of ['lobby-deal-mode-fieldset', 'lobby-seat-fieldset', 'lobby-bot-difficulty-fieldset',
    'lobby-hand-count-fieldset', 'lobby-base-unit-fieldset', 'lobby-rule-preset-fieldset',
    'lobby-seed', 'lobby-save-defaults', 'lobby-quick-match']) assert.equal(h.ids.get(id).closest('details'), advanced, id);
  assert.equal(h.ids.get('lobby-apply').textContent.trim(), 'Start game');
  h.ids.get('lobby-apply').click();
  assert.equal(h.navigations.length, 1);
  const q = h.navigations[0].searchParams;
  assert.match(q.get('gameId'), /^changsha-/);
  assert.equal(q.get('variant'), 'changsha');
  assert.equal(q.get('dealMode'), 'auto');
  assert.equal(q.get('botCount'), '3');
  assert.equal(q.get('botDifficulty'), 'Hard');
  assert.equal(q.get('handCount'), '4');
  assert.equal(q.get('baseUnit'), '1');
  assert.equal(q.get('seed'), null);
});

test('advanced controls keep their real payload, saved preferences, validation and spectator/bot gating when collapsed again', () => {
  const h = fixture();
  const advanced = h.ids.get('lobby-advanced'); advanced.open = true;
  h.change('lobby-deal-mode', 'manual');
  h.change('lobby-bot-difficulty', 'Easy');
  h.change('lobby-hand-count', '8');
  h.change('lobby-seat', '-1');
  assert.equal(h.document.querySelector('input[name="lobby-bot-count"]:checked').value, '4');
  h.fill('lobby-base-unit', '7'); h.fill('lobby-seed', '13572468');
  h.ids.get('lobby-save-defaults').checked = true;
  advanced.open = false;
  assert.match(h.ids.get('lobby-advanced-summary').textContent, /8 hands/);
  assert.match(h.ids.get('lobby-advanced-summary').textContent, /Spectate/);
  h.ids.get('lobby-apply').click();
  const q = h.navigations[0].searchParams;
  for (const [key, value] of Object.entries({ dealMode: 'manual', botCount: '4', botDifficulty: 'Easy',
    handCount: '8', seat: '-1', baseUnit: '7', seed: '13572468' })) assert.equal(q.get(key), value, key);
  const saved = JSON.parse(h.storage.get('mahjong.lobby.defaults'));
  const reloaded = fixture({ saved });
  assert.equal(reloaded.ids.get('lobby-advanced').open, false);
  reloaded.ids.get('lobby-apply').click();
  for (const key of ['variant', 'dealMode', 'botCount', 'botDifficulty', 'handCount', 'seat', 'baseUnit', 'seed'])
    assert.equal(reloaded.navigations[0].searchParams.get(key), q.get(key), key);
  const invalid = fixture();
  invalid.fill('lobby-seed', 'invalid');
  invalid.ids.get('lobby-advanced').open = false;
  invalid.ids.get('lobby-apply').click();
  assert.equal(invalid.navigations.length, 0);
  assert.equal(invalid.ids.get('lobby-advanced').open, true);
  assert.equal(invalid.document.activeElement, invalid.ids.get('lobby-seed'));
  invalid.fill('lobby-seed', ''); invalid.fill('lobby-base-unit', '0');
  invalid.ids.get('lobby-advanced').open = false;
  invalid.ids.get('lobby-apply').click();
  assert.equal(invalid.navigations.length, 0);
  assert.equal(invalid.ids.get('lobby-advanced').open, true);
  assert.equal(invalid.document.activeElement, invalid.ids.get('lobby-base-unit'));
});

test('all five real variant options change the open setup draft, not the current room, until the single Start action', () => {
  for (const variant of ['changsha', 'four-player', 'three-player', 'bamboo', 'minefield']) {
    const h = fixture({ saved: { variant } });
    h.ids.get('lobby-advanced').open = true;
    h.change('lobby-hand-count', '8');
    h.fill('lobby-seed', '2468');
    h.loader.load('ui/variant-picker.ts');
    const select = h.document.getElementById('ferro-variant-select');
    assert.equal(select.value, variant, 'the visible variant must agree with saved setup values before Start');
    select.value = variant; select.dispatchEvent(new Event('change'));
    assert.equal(h.navigations.length, 0, variant);
    assert.equal(h.document.querySelector('input[name="lobby-variant"]:checked').value, variant);
    h.ids.get('lobby-apply').click();
    assert.equal(h.navigations.length, 1);
    assert.equal(h.navigations[0].searchParams.get('variant'), variant);
    assert.equal(h.navigations[0].searchParams.get('handCount'), '8');
    assert.equal(h.navigations[0].searchParams.get('seed'), '2468');
  }
  const preferred = fixture({ preferredVariant: 'bamboo' });
  preferred.loader.load('ui/variant-picker.ts');
  assert.equal(preferred.document.getElementById('ferro-variant-select').value, 'bamboo');
  preferred.ids.get('lobby-apply').click();
  assert.equal(preferred.navigations[0].searchParams.get('variant'), 'bamboo');
});

test('zero-bot friend tables and the retained advanced Quick Match keep their distinct unchanged configurations', () => {
  const friends = fixture();
  friends.change('lobby-bot-count', '0');
  assert(friends.document.querySelectorAll('input[name="lobby-bot-difficulty"]').every(input => input.disabled));
  friends.ids.get('lobby-apply').click();
  assert.equal(friends.navigations[0].searchParams.get('botCount'), '0');
  assert.equal(friends.navigations[0].searchParams.get('botDifficulty'), null);
  const quick = fixture();
  quick.ids.get('lobby-advanced').open = true;
  quick.change('lobby-hand-count', '8'); quick.fill('lobby-base-unit', '9');
  quick.ids.get('lobby-quick-match').click();
  const q = quick.navigations[0].searchParams;
  for (const [key, value] of Object.entries({ botCount: '3', botDifficulty: 'Medium', seat: '0',
    handCount: '8', baseUnit: '9' })) assert.equal(q.get(key), value, key);
});
