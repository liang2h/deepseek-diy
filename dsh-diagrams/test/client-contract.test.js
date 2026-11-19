// Contract-level unit tests for the Desktop 0.2.2-rc.5 Client APIs, not a DOM
// emulator or visual acceptance test. Render effects are recorded, not executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {apply as applyHost} from '../index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = buildSync({
  absWorkingDir: root, entryPoints: ['client.js'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022', external: ['./renderer.js'],
}).outputFiles[0].text;
const distribution = readFileSync(new URL('../client.bundle.js', import.meta.url), 'utf8');
const slot = 'conversation.chat.markdown.fence';

function loadClient(code = source) {
  let entry;
  vm.runInNewContext(code, {window: {__ModuleLoader__: {load(value) { entry = value; }}}});
  assert.equal(entry.id, manifest.name);
  return entry;
}

function harness(code = source) {
  const entry = loadClient(code);
  const effects = [], registrations = [], styles = [], dictionaries = new Map();
  const localeListeners = new Set(), themeListeners = new Set();
  const state = [], renderEffects = [], subscriptions = [];
  let cursor = 0, language = 'zh';
  let theme = {active: {id: 'light', colorScheme: 'light'}, revision: 0};
  let localeSnapshot = {active: 'zh', revision: 0};
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return {type, props: {...props, children}}; },
    useEffect(fn, deps) { renderEffects.push({fn, deps}); },
    useRef() { return {current: null}; },
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      assert.equal(getSnapshot, getServerSnapshot);
      subscriptions.push(subscribe(() => {}));
      return getSnapshot();
    },
  };
  const required = [];
  const plugin = entry.factory(name => {
    required.push(name);
    assert.equal(name, 'react', 'React comes from the Host module table');
    return react;
  });
  assert.deepEqual(required, ['react']);
  const document = {
    createElement(tag) {
      assert.equal(tag, 'style');
      return {textContent: '', remove() { styles.splice(styles.indexOf(this), 1); }};
    },
    head: {append(style) { styles.push(style); }},
  };
  // The module factory has no DOM access; apply receives its document realm.
  // Re-evaluate to give apply that realm while retaining the same fake React.
  let scopedEntry;
  vm.runInNewContext(code, {document, window: {__ModuleLoader__: {load(value) { scopedEntry = value; }}}});
  const scopedPlugin = scopedEntry.factory(() => react);
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    locale: {
      register(ns, dicts) { dictionaries.set(ns, dicts); return () => dictionaries.delete(ns); },
      bind(ns) { return key => dictionaries.get(ns)?.[language]?.[key] ?? key; },
      subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn); },
      getSnapshot() { return localeSnapshot; },
    },
    theme: {getTheme() { return theme; }},
    on(event, fn) {
      assert.equal(event, 'theme/change');
      themeListeners.add(fn);
      return () => themeListeners.delete(fn);
    },
    slots: {
      inject(name, callback) { assert.equal(name, slot); return ctx.effect(callback); },
      register(options, component) {
        const registration = {options, component};
        registrations.push(registration);
        return () => registrations.splice(registrations.indexOf(registration), 1);
      },
    },
  };
  scopedPlugin.apply(ctx);
  return {
    plugin, registrations, styles, dictionaries, localeListeners, themeListeners,
    render(props) {
      for (const dispose of subscriptions.splice(0)) dispose();
      cursor = 0; renderEffects.length = 0;
      const tree = registrations[0].component(props);
      return {tree, renderEffects};
    },
    switchLocale(value) {
      language = value;
      localeSnapshot = {active: value, revision: localeSnapshot.revision + 1};
      for (const listener of localeListeners) listener();
    },
    switchTheme(colorScheme) {
      theme = {active: {id: 'custom-theme', colorScheme}, revision: theme.revision + 1};
      for (const listener of themeListeners) listener(theme);
    },
    dispose() {
      for (const dispose of subscriptions.splice(0)) dispose();
      for (const dispose of effects.reverse()) dispose();
    },
  };
}

function nodes(tree) {
  if (tree === null || tree === undefined || tree === false) return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== 'object') return [tree];
  return [tree, ...nodes(tree.props?.children)];
}

function button(tree, label) {
  return nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === label);
}

const code = 'sequenceDiagram\nA->>B: 登录';
const originalSource = {type: 'original-code-block', props: {code}};
const props = {lang: 'mermaid', code, streaming: false, meta: 'optional-info', children: originalSource};

test('rc.5 Client registration uses the language-keyed hoc contract and owns cleanup', () => {
  const client = harness();
  assert.deepEqual(Array.from(client.plugin.inject), ['slots', 'locale', 'theme']);
  assert.equal(client.styles.length, 1);
  assert.ok(client.styles[0].textContent.includes('--dsw-alias-bg-layer-1'));
  assert.deepEqual(Array.from(client.dictionaries.get(manifest.name) ? Object.keys(client.dictionaries.get(manifest.name)) : []), ['zh', 'en']);
  assert.equal(client.registrations.length, 2);
  for (const [index, language] of ['mermaid', 'mmd'].entries()) {
    const {options, component} = client.registrations[index];
    assert.equal(options.name, slot);
    assert.equal(options.key, language);
    assert.equal(options.id, `${manifest.name}/${manifest.version}/${language}`);
    assert.equal(options.order, 10);
    assert.equal(typeof component, 'function');
  }
  assert.equal(client.registrations[0].component, client.registrations[1].component);
  client.dispose();
  assert.equal(client.styles.length, 0);
  assert.equal(client.dictionaries.size, 0);
  assert.equal(client.registrations.length, 0);
});

test('shipped Client bundle registers the same current-generation slot IDs as source', () => {
  const client = harness(distribution);
  assert.equal(manifest.version, '1.0.1');
  assert.equal(manifest.engines.dsh, '0.2.2-rc.5');
  assert.deepEqual(client.registrations.map(({options}) => options.id), [
    `${manifest.name}/1.0.1/mermaid`, `${manifest.name}/1.0.1/mmd`,
  ]);
  client.dispose();
});

test('streaming preserves the Host code-block child exactly once without inserting SVG', () => {
  const client = harness();
  const {tree, renderEffects} = client.render({...props, streaming: true});
  assert.equal(nodes(tree).filter(node => node === originalSource).length, 1);
  assert.equal(button(tree, '图表').props.disabled, true);
  assert.equal(button(tree, '源码').props['aria-pressed'], true);
  assert.equal(nodes(tree).some(node => node.props?.dangerouslySetInnerHTML), false);
  assert.equal(renderEffects.length, 2);
  assert.equal(renderEffects[1].deps[1], true);
  client.dispose();
});

test('settled fences keep source accessible and receive the original owner props unchanged', () => {
  const client = harness();
  const first = client.render(props);
  assert.equal(nodes(first.tree).filter(node => node === originalSource).length, 0);
  assert.equal(button(first.tree, '图表').props.disabled, false);
  assert.equal(first.renderEffects[1].deps[0], code);
  button(first.tree, '源码').props.onClick();
  const source = client.render(props).tree;
  assert.equal(nodes(source).filter(node => node === originalSource).length, 1);
  assert.equal(button(source, '源码').props['aria-pressed'], true);
  assert.equal(props.code, code);
  client.dispose();
});

test('rc.5 theme active.colorScheme and locale snapshots update without writing Host preferences', () => {
  const client = harness();
  const light = client.render(props);
  assert.equal(light.renderEffects[1].deps[2], false);
  assert.equal(light.tree.props['aria-label'], '时序图');
  client.switchTheme('dark');
  client.switchLocale('en');
  const dark = client.render(props);
  assert.equal(dark.renderEffects[1].deps[2], true, 'colorScheme, not the custom theme ID, selects the palette');
  assert.equal(dark.tree.props['aria-label'], 'Sequence diagram');
  assert.equal(client.localeListeners.size, 1);
  assert.equal(client.themeListeners.size, 1);
  client.dispose();
  assert.equal(client.localeListeners.size, 0);
  assert.equal(client.themeListeners.size, 0);
});

test('Host entry remains presentation-only and does not read or write services', () => {
  const inaccessible = new Proxy({}, {get() { assert.fail('Host service access'); }, set() { assert.fail('Host mutation'); }});
  assert.equal(applyHost(inaccessible), undefined);
});
