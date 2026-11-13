import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {markdownTree, safeMarkdownUrl} from '../markdown.js';

// Assert the actual parser's plain semantic tree, not a React/DOM simulation.
const flatten = nodes => nodes.flatMap(node => typeof node === 'string' ? [] : [node, ...flatten(node.children)]);
const select = (nodes, tag) => flatten(nodes).filter(node => node.tag === tag);
const text = nodes => nodes.map(node => typeof node === 'string' ? node : text(node.children)).join('');
const screenshot = `字段对应关系：

| Codex | DSH | 说明 |
|---|---|---|
| \`mcp_servers.agentlens\` | \`serverName: agentlens\` | 本地服务命名及工具命名空间 |
| \`url\` | \`url\` | MCP 服务地址 |
| 根据 URL 采用 HTTP 连接 | \`transport: streamable-http\` | DSH 显式指定传输方式 |
| \`http_headers\`，若配置 | \`headers\` | 附加 HTTP 请求头 |
| \`enabled_tools\` | **当前没有直接对应字段** | 不能机械迁移白名单 |
| \`scopes\`，若配置 | **当前没有直接对应字段** | 不代表 DSH 已具备完整 OAuth 流程 |

> **重要：上述 YAML 只对应“连接到同一个服务”**，不是当前 Codex 配置的完整等价版本。
> 不要自行加入 \`enabled_tools\` 字段。

连接成功后，DSH 中的工具名会类似：`;

test('screenshot regression: renders six table rows and keeps the following quote separate', () => {
  const tree = markdownTree(screenshot, '表格');
  assert.deepEqual(tree.map(node => node.tag), ['p', 'div', 'blockquote', 'p']);
  assert.equal(select(tree, 'table').length, 1);
  assert.deepEqual(select(tree, 'th').map(node => text(node.children)), ['Codex', 'DSH', '说明']);
  assert.equal(select(tree, 'td').length, 18);
  assert.equal(select(tree, 'tbody')[0].children.length, 6);
  assert.ok(select(tree, 'code').some(node => text(node.children) === 'transport: streamable-http'));
  assert.equal(select(tree, 'strong').length, 3);
  assert.equal(tree[1].props['aria-label'], '表格');
  assert.equal(tree[1].props.tabIndex, 0);
  assert.ok(select(tree, 'th').every(node => node.props.scope === 'col'));
});

test('GFM tables preserve alignment, inline formatting, escaped pipes and missing cells', () => {
  const tree = markdownTree('字段 | 居中 | 靠右\n:--- | :---: | ---:\n`a\\|b` | **重点** [链接](https://example.com) | ~~旧~~\nx | y');
  assert.deepEqual(select(tree, 'th').map(node => node.props.style.textAlign), ['left', 'center', 'right']);
  assert.equal(select(tree, 'code')[0].children[0], 'a|b');
  assert.equal(select(tree, 'a')[0].props.href, 'https://example.com/');
  assert.equal(select(tree, 'del')[0].children[0], '旧');
  assert.equal(select(tree, 'tbody')[0].children[1].children.length, 3);
});

test('headings, ordered/unordered nested lists, tasks, rules, emphasis and hard breaks', () => {
  const tree = markdownTree('# 标题\n\n副标题\n---\n\n3. 第三项\n   - *嵌套*\n   - [x] 完成\n   - [ ] 待办\n\n---\n\n**重点** 与 ~~旧内容~~  \n下一行');
  assert.equal(select(tree, 'h1').length, 1);
  assert.equal(select(tree, 'h2').length, 1);
  assert.equal(select(tree, 'ol')[0].props.start, 3);
  assert.equal(select(tree, 'ul').length, 1);
  assert.equal(select(tree, 'em')[0].children[0], '嵌套');
  assert.deepEqual(select(tree, 'input').map(node => node.props.checked), [true, false]);
  assert.ok(select(tree, 'input').every(node => node.props.disabled && node.props.readOnly));
  assert.equal(select(tree, 'hr').length, 1);
  assert.equal(select(tree, 'br').length, 1);
});

test('fenced code remains literal, supports longer/tilde fences and unfinished streamed code', () => {
  const tree = markdownTree('````yaml\n```\n| a | b |\n|---|---|\n<script>alert(1)</script>\n````\n\n~~~js\nconst unfinished = true;');
  assert.equal(select(tree, 'pre').length, 2);
  assert.equal(select(tree, 'table').length, 0);
  assert.equal(select(tree, 'code')[0].children[0], '```\n| a | b |\n|---|---|\n<script>alert(1)</script>');
  assert.equal(select(tree, 'code')[1].children[0], 'const unfinished = true;');
});

test('inline code keeps literal entities; escaped Markdown and text entities stay readable', () => {
  const tree = markdownTree('\\*字面量\\* &amp; &lt;safe&gt; &#x4e2d;\n\n`&amp; **not bold**`');
  assert.equal(select(tree, 'strong').length, 0);
  assert.equal(select(tree, 'code')[0].children[0], '&amp; **not bold**');
  assert.equal(text(tree), '*字面量* & <safe> 中&amp; **not bold**');
});

test('links are safe and explicit; image URLs are not fetched', () => {
  const tree = markdownTree('[网页](https://example.com/?x=1&amp;y=2 "说明") [邮箱](mailto:a@example.com) [本地文件](/tmp/example.md) ![图片说明](https://example.com/tracker.png)\n\nhttps://example.com/docs');
  assert.equal(select(tree, 'a').length, 3);
  assert.equal(select(tree, 'a')[0].props.href, 'https://example.com/?x=1&y=2');
  assert.equal(select(tree, 'a')[0].props.title, '说明');
  assert.ok(select(tree, 'a').every(node => node.props.target === '_blank' && node.props.rel === 'noopener noreferrer'));
  assert.equal(select(tree, 'img').length, 0);
  assert.ok(text(tree).includes('本地文件'));
  assert.ok(text(tree).includes('图片说明'));
});

test('script URLs, HTML/event attributes and hostile image sources cannot become executable nodes', () => {
  const tree = markdownTree('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,evil) ![alt](javascript:alert%281%29)\n\n&lt;svg onload=alert(1)&gt;');
  assert.equal(select(tree, 'a').length, 0);
  assert.ok(text(tree).includes('<script>alert(1)</script>'));
  assert.ok(text(tree).includes('<img src=x onerror=alert(1)>'));
  for (const node of flatten(tree)) {
    assert.ok(!['script', 'img', 'iframe', 'svg', 'style', 'object'].includes(node.tag));
    assert.ok(!Object.keys(node.props).some(key => /^on|innerhtml|src|dangerously/i.test(key)));
  }
  for (const href of ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,x', '//evil.test', '/tmp/file', 'file:///tmp/a', 'https:\\evil.test', 'https://good.test/\u0000x', 'https://good.test/\nx']) {
    assert.equal(safeMarkdownUrl(href), undefined, href);
  }
});

test('every streamed prefix is parseable; completed tables do not consume adjacent blocks', () => {
  const input = screenshot + '\n\n```yaml\nurl: https://example.com\n```\n\n- 完成';
  for (let end = 0; end <= input.length; end++) assert.doesNotThrow(() => markdownTree(input.slice(0, end)));
  assert.equal(select(markdownTree(input), 'table').length, 1);
  assert.equal(select(markdownTree(input), 'ul').length, 1);
  assert.equal(select(markdownTree('不是表格 | 仍是段落\n- 普通列表'), 'table').length, 0);
  assert.deepEqual(markdownTree(''), []);
});

test('CRLF Markdown has identical structure to LF Markdown', () => {
  assert.deepEqual(markdownTree(screenshot.replace(/\n/g, '\r\n')), markdownTree(screenshot));
});

test('table overflow is contained, styled with theme tokens and keyboard-focusable', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /\.sc-table-scroll\{[^}]*max-width:100%;[^}]*overflow-x:auto/);
  assert.match(source, /\.sc-table-scroll:focus-visible/);
  assert.match(source, /\.sc-markdown th\{[^}]*var\(--dsw-alias-bg-layer-1\)/);
  assert.match(source, /tableLabel: text\('table'\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|require\(['"]@deepseek-ai\/dsh-client/);
});

test('published client is a self-contained bundle with parser license and no runtime npm imports', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.bundle.js');
  assert.ok(manifest.files.includes('client.bundle.js'));
  assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.equal(manifest.dependencies, undefined);
  const bundle = await readFile(new URL('../client.bundle.js', import.meta.url), 'utf8');
  assert.match(bundle, /window\.__ModuleLoader__\.load/);
  assert.match(bundle, /sc-table-scroll/);
  assert.doesNotMatch(bundle, /(?:import|require)\s*\(\s*['"](?:marked|esbuild|\.\/markdown)/);
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /MarkedJS/); assert.match(notices, /John Gruber/);
});
