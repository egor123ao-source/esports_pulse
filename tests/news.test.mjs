import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { escapeHTML, newsMatchesGame, safeURL } from '../app-core.js';

// Execute the actual news renderer without network requests or app startup.
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing renderer section: ${start}`);
  return source.slice(from, to);
}
const renderer = section('function chips(', 'function replaceMarkup(')
  + section('function newsList(', 'function renderHero(');

// A small DOM double models node identity, replacement, attributes and handlers.
class Element {
  constructor() { this.dataset = {}; this.attributes = {}; this.children = []; this.value = ''; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(child) { this.children.push(child); }
  set innerHTML(html) {
    this.html = html; this.children = [];
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const button = new Element(); button.textContent = match[2];
      for (const attr of match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) button.setAttribute(attr[1], attr[2] ?? '');
      this.append(button);
    }
  }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(selector) {
    return this.children.filter(child => selector === 'button'
      || selector.startsWith('#') && child.getAttribute('id') === selector.slice(1)
      || selector.startsWith('[') && child.getAttribute(selector.slice(1, -1)) !== null);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function harness() {
  const nodes = Object.fromEntries(['nf', 'nq', 'ng', 'news-status', 'news-more'].map(id => [id, new Element()]));
  const select = selector => nodes[selector.slice(1)] || Object.values(nodes).map(node => node.querySelector(selector)).find(Boolean) || null;
  let saved = [], heroRenders = 0;
  const context = vm.createContext({
    $: select, document: { createElement: () => new Element() }, esc: escapeHTML,
    hs: value => escapeHTML(safeURL(value)), newsMatchesGame, game: 'all',
    news: Array.from({ length: 8 }, (_, i) => ({ title: `CS2 original ${i}`, tt: `CS2 перевод ${i}`, src: i % 2 ? 'HLTV' : 'Dexerto', link: `https://example.com/news/${i}` })),
    newsSource: 'Все', newsLimit: 6, original: false, newsState: {},
    arrayStore: () => saved,
    save: (key, value) => { if (key === 'bk') saved = value; },
    statusMarkup: () => '', ago: () => 'сейчас', loading: () => 'Загрузка', stateBox: title => title,
    renderHero: () => { heroRenders++; },
  });
  vm.runInContext('const title = n => !original && n.tt ? n.tt : n.title; const summary = n => n.sum || "";', context);
  vm.runInContext(renderer, context);
  const render = () => vm.runInContext('renderNews()', context);
  const languages = () => nodes.nf.children.filter(button => /^Показать (оригинал|перевод)$/.test(button.textContent));
  return { nodes, context, render, languages, heroRenders: () => heroRenders };
}

test('news rerenders keep exactly one language control, including search and pagination', () => {
  const h = harness(); h.render();
  assert.equal(h.languages().length, 1);
  for (let i = 0; i < 25; i++) { h.nodes.nq.value = i % 2 ? 'CS2' : ''; h.render(); }
  assert.equal(h.languages().length, 1);
  h.nodes['news-more'].querySelector('#more-news').onclick();
  assert.equal(h.languages().length, 1);
});

test('language toggle keeps its node and alternates label, pressed state and article titles', () => {
  const h = harness(); h.render(); const control = h.languages()[0];
  for (let i = 0; i < 10; i++) {
    control.onclick();
    assert.equal(h.languages().length, 1);
    assert.equal(h.languages()[0], control, 'Keep the focused control mounted');
    const original = i % 2 === 0;
    assert.equal(control.textContent, original ? 'Показать перевод' : 'Показать оригинал');
    assert.equal(control.getAttribute('aria-pressed'), String(original));
    assert.match(h.nodes.ng.innerHTML, original ? /CS2 original 0/ : /CS2 перевод 0/);
  }
  assert.equal(h.heroRenders(), 10);
});

test('changing sources and saved count rebuilds filters with one working language control', () => {
  const h = harness(); h.render();
  h.nodes.nf.children.find(button => button.dataset.k === 'HLTV').onclick();
  assert.equal(h.languages().length, 1);
  assert.doesNotMatch(h.nodes.ng.innerHTML, /CS2 перевод 0/);
  h.nodes.ng.children.find(button => button.dataset.news === '0').onclick();
  assert.equal(h.languages().length, 1);
  assert.ok(h.nodes.nf.children.some(button => button.textContent === 'Сохранённые (1)'));
  h.languages()[0].onclick();
  assert.equal(h.languages().length, 1);
  assert.equal(h.languages()[0].textContent, 'Показать перевод');
});
