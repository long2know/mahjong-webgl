import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { root, sourceLoader } from './renderer-test-support.mjs';
const catalogs = Object.fromEntries(['en', 'zh-Hans', 'zh-Hant'].map(locale =>
  [locale, JSON.parse(fs.readFileSync(path.join(root, `src/i18n/${locale}.json`), 'utf8'))]));

export class TileElement extends EventTarget {
  constructor(tag = 'div', document = null) {
    super(); this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.dataset = {}; this.attributes = {}; this.classes = new Set(); this.text = '';
    this.hidden = false; this.disabled = false; this.open = false; this.tabIndex = -1;
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.classes.has(name),
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      toggle: (name, value = !this.classes.has(name)) => value ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  set innerHTML(value) { this.replaceChildren(); this.text = String(value); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] ?? null;
    return this.attributes[name] ?? null;
  }
  appendChild(child) { if (child.parentElement) child.remove(); this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentElement = null; });
    this.children = []; this.text = ''; this.append(...children);
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  matches(selector) {
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return attr[2] === undefined ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2];
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.descendants()]);
    return all.filter(child => selector.split(',').some(value => child.matches(value.trim())));
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() {
    if (this.disabled || this.hidden) return;
    const event = new Event('click', { cancelable: true }); this.onclick?.(event); this.dispatchEvent(event);
  }
}

export function tileUiFixture({ claim = null, things = [], locale = 'en' } = {}) {
  const document = Object.assign(new EventTarget(), { activeElement: null });
  document.body = new TileElement('body', document);
  document.createElement = tag => new TileElement(tag, document);
  const markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = document.createElement(match[1]); element.id = match[3];
    for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    element.hidden = /\shidden(?:\s|$)/.test(match[2]); element.checked = /\schecked(?:\s|$)/.test(match[2]);
    document.body.appendChild(element);
  }
  document.getElementById = id => document.body.querySelector(`#${id}`);
  const node = id => document.getElementById(id);
  node('rule-action-choice-dialog').append(node('rule-action-choice-title'), node('rule-action-choice-hint'),
    node('rule-action-choices'), node('rule-action-choice-cancel'));
  const actions = document.createElement('div'); actions.id = 'browser-action-slot'; document.body.appendChild(actions);
  let now = 100_000, timer = 0;
  const timers = new Map(), intervals = new Map(), languages = [], notices = [];
  const location = new URL('http://tile-ui.fixture/?gameId=tile-room&variant=changsha');
  const window = Object.assign(new EventTarget(), {
    location, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (callback, delay = 0) => { const id = ++timer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => { const id = ++timer; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
  });
  const collection = values => {
    const data = new Map(values);
    return { data, get: key => data.get(key) ?? null, entries: () => data.entries() };
  };
  const client = Object.assign(new EventEmitter(), {
    seat: 0, lastGameId: 'tile-room', serverSnapshotGameId: 'tile-room', seatPlayers: ['self', 'bot-one', 'bot-two', 'bot-three'],
    connected: () => true, playerId: () => 'self', sent: [],
    update(entries) { this.sent.push(entries); },
    claim: collection(claim ? [['0', { ...claim, deadline: claim.deadline ?? now + 8000 }]] : []),
    ownTurn: collection([]), turn: collection([['current', { phase: 'AwaitingClaim', activeSeat: 0 }]]),
    gameComplete: collection([]), actionRejected: collection([]), things: collection(things),
    nicks: collection([['self', 'Human One'], ['bot-one', 'Bamboo Fox'], ['bot-two', 'Jade Otter'], ['bot-three', 'Crimson Crane']]),
  });
  const translate = (key, values = {}) => (catalogs[locale][key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''));
  const loader = sourceLoader({
    window, document, location, HTMLElement: TileElement,
    Date: class extends Date { static now() { return now; } },
  }, {
    'i18n.ts': { t: translate, onLanguageChange: callback => languages.push(callback) },
    'toast.ts': { showToast: (...notice) => notices.push(notice) },
  });
  return {
    ...loader, document, window, client, node, notices, timers, intervals,
    language: next => { locale = next; languages.forEach(callback => callback(next)); },
    time: () => now,
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, task] of [...timers]) if (task.at <= now && timers.has(id)) { timers.delete(id); task.callback(); }
      for (const task of [...intervals.values()]) task.callback();
    },
    receive(entries, full = false) {
      if (full) for (const kind of ['claim', 'ownTurn', 'turn', 'gameComplete', 'actionRejected']) client[kind].data.clear();
      for (const [kind, key, value] of entries) {
        const collection = client[kind];
        if (value === null) collection.data.delete(key); else collection.data.set(key, value);
      }
      client.emit('update', entries, full);
    },
  };
}
