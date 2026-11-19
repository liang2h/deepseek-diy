import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareSource, diagramKind, clampZoom, fitScale, safeCssValue, createRenderQueue, formatZoom, MAX_SOURCE_LENGTH} from '../diagram.js';

test('detects common diagrams without touching normal prose or source', () => {
  for (const [code, kind] of [['sequenceDiagram\nA->>B: 登录', 'sequence'], ['%% comment\nflowchart TD\nA-->B', 'flowchart'], ['stateDiagram-v2\n[*]-->A', 'state'], ['classDiagram\nA-->B', 'class'], ['erDiagram\nA ||--o{ B : has', 'er'], ['mindmap\n  root((主题))', 'mindmap']]) {
    assert.equal(diagramKind(code), kind);
    assert.equal(prepareSource(code), code);
  }
  assert.equal(diagramKind('normal text'), 'diagram');
});

test('ignores embedded configuration while preserving diagram body', () => {
  assert.equal(prepareSource('%%{init: {"securityLevel":"loose","theme":"dark"}}%%\nflowchart TD\nA-->B'), 'flowchart TD\nA-->B');
  assert.equal(prepareSource('---\nconfig:\n  securityLevel: loose\ntitle: hello\n---\nsequenceDiagram\nA->>B: hi'), 'sequenceDiagram\nA->>B: hi');
  assert.equal(prepareSource('\uFEFF  graph LR\nA-->B  '), 'graph LR\nA-->B');
});

test('limits input and blocks pre-sanitization asset requests / style escapes', () => {
  for (const [code, key] of [[' ', 'empty'], ['x'.repeat(MAX_SOURCE_LENGTH + 1), 'tooLarge'], ['---\nconfig: true', 'invalid'], ['flowchart LR\nA@{ img: "https://x.test/a" }', 'unsupportedMetadata'], ['flowchart LR\nA["![image](https://x.test/a)"]', 'externalAsset'], ['flowchart LR\nclassDef x fill:red;}body{display:none}', 'customStyle'], ['flowchart LR\nA["<img src=x>"]', 'externalAsset'], ['flowchart LR\nstyle A fill:url(https://x.test/a)', 'customStyle']]) {
    assert.throws(() => prepareSource(code), error => error.key === key, code.slice(0, 100));
  }
});

test('paint references stay local; CSS escapes and network values fail closed', () => {
  for (const value of ['#edf3ff', '14px', '1.5', 'url(#arrow-1)', 'url("#arrow-1")']) assert.equal(safeCssValue(value), true, value);
  for (const value of ['url(https://evil.test/a)', 'url(data:image/svg+xml,a)', '@import "x"', 'u\\72l(x)', 'expression(alert(1))', '</style><script>']) assert.equal(safeCssValue(value), false, value);
});

test('zoom is bounded and fit never enlarges diagrams', () => {
  assert.equal(clampZoom(0), 0.25); assert.equal(clampZoom(100), 3);
  assert.equal(clampZoom(1.1500000001), 1.15);
  assert.equal(fitScale(1000, 540), 0.5); assert.equal(fitScale(100, 540), 1);
  assert.equal(fitScale(0, 0), 1); assert.equal(fitScale(20000, 300), 0.013);
  assert.ok(fitScale(60000, 300) * 60000 <= 260);
  assert.equal(formatZoom(fitScale(60000, 300)), '<1%');
  assert.equal(formatZoom(1), '100%');
});

test('configuration stripping reaches a fixed point without exposing frontmatter', () => {
  const body = 'flowchart LR\nA-->B';
  const frontmatter = '---\nconfig:\n  htmlLabels: true\n  theme: dark\n---\n';
  for (const raw of ['%%{init: {}}%%\n' + frontmatter + body, frontmatter + frontmatter + body, (frontmatter + body).replace(/\n/g, '\r')]) {
    assert.equal(prepareSource(raw), body);
    assert.equal(prepareSource(prepareSource(raw)), body);
  }
  assert.equal(prepareSource('sequenceDiagram\nA->>B: 调用 URL()'), 'sequenceDiagram\nA->>B: 调用 URL()');
});

test('all optional metadata and author CSS are blocked before rendering', () => {
  for (const key of ['img', '"img"', "'img'", String.raw`"im\u0067"`]) {
    assert.throws(() => prepareSource('flowchart LR\nA@{ ' + key + ': "https://example.invalid/a.png" }'), error => error.key === 'unsupportedMetadata');
  }
  for (const style of ['\nclassDef x fill:red;', ';style A fill:red;', '\nlinkStyle 0 stroke:red;']) {
    assert.throws(() => prepareSource('flowchart LR\nA-->B' + style), error => error.key === 'customStyle');
  }
  for (const value of ['image-set("https://example.invalid/a" 1x)', '-webkit-image-set("https://example.invalid/a" 1x)', 'src("https://example.invalid/a")']) {
    assert.equal(safeCssValue(value), false);
  }
});

test('renderer queue serializes shared configuration and recovers after errors', async () => {
  const enqueue = createRenderQueue(); const order = [];
  let release;
  const first = enqueue(async () => { order.push('first'); await new Promise(resolve => {release = resolve;}); throw Error('invalid syntax'); });
  const second = enqueue(async () => { order.push('second'); return 'ok'; });
  await Promise.resolve(); assert.deepEqual(order, ['first']); release();
  await assert.rejects(first); assert.equal(await second, 'ok');
  assert.deepEqual(order, ['first', 'second']);
});

test('metadata and UI are bilingual and exports include distributable runtime', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root)));
  const zh = JSON.parse(await readFile(new URL('locale/zh.json', root)));
  const en = JSON.parse(await readFile(new URL('locale/en.json', root)));
  assert.deepEqual(Object.keys(zh.ui).sort(), Object.keys(en.ui).sort());
  assert.equal(manifest.version, '1.0.1');
  assert.equal(manifest.engines.dsh, '0.2.2-rc.5');
  assert.ok(zh.meta.description.includes('0.2.2-rc.5'));
  assert.ok(en.meta.description.includes('0.2.2-rc.5'));
  assert.equal(manifest.exports['./client'], './client.bundle.js');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.ok(manifest.files.includes('locale/*.json'));
  assert.equal(zh.meta.detail, undefined, 'uses the existing README detail fallback');
  assert.equal(en.meta.detail, undefined, 'uses the existing README detail fallback');
  for (const path of ['index.js', 'client.js', 'renderer.js', 'diagram.js', 'styles.js', 'client.bundle.js', 'cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md', 'icon.svg']) {
    assert.ok(manifest.files.includes(path), path);
    assert.ok((await readFile(new URL(path, root))).length > 0, path);
  }
  assert.ok(zh.meta.title && en.meta.title && zh.meta.description && en.meta.description);
});
