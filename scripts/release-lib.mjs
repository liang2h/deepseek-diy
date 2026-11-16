import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PLUGINS = ['dsh-codex-mcp', 'dsh-git-manager', 'dsh-personalization', 'dsh-side-chat', 'dsh-auto-review-codex-compat'];

export function releaseOptions({repo, tag, commit}) {
  assert.match(repo ?? '', /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/, 'repo must be OWNER/REPO');
  assert.ok(!repo.split('/').some(part => part === '.' || part === '..'), 'invalid repository');
  assert.match(tag ?? '', /^plugins-v\d+\.\d+\.\d+$/, 'tag must be plugins-vX.Y.Z (a stable collection release)');
  assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'commit must be a full lowercase 40-character Git SHA');
  assert.ok(!/^0+$/.test(commit), 'commit must not be the null SHA');
  return {repo, tag, commit};
}

export function pnpm(args, {cwd = ROOT, capture = false} = {}) {
  const cli = process.env.PNPM_CLI || process.env.npm_execpath;
  const useNode = cli && /pnpm[^/\\]*\.(?:c?js|mjs)$/.test(cli);
  return execFileSync(useNode ? process.execPath : 'pnpm', useNode ? [cli, ...args] : args, {
    cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

export async function pluginRecords(root = ROOT) {
  return Promise.all(PLUGINS.map(async directory => {
    const manifest = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    const {meta} = JSON.parse(await readFile(path.join(root, directory, 'locale/zh.json'), 'utf8'));
    assert.equal(manifest.name, '@local/' + directory);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    return {directory, manifest, meta, filename: directory + '-' + manifest.version + '.tgz'};
  }));
}

export function makeIndex(records, options, timestamp = Math.floor(Date.now() / 1000)) {
  const {repo, commit} = releaseOptions(options);
  assert.ok(Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 1e11, 'timestamp must be Unix seconds');
  return {
    format: 1,
    title: 'DeepSeek DIY 插件',
    plugins: records.map(({directory, manifest, meta}) => ({
      name: manifest.name,
      title: meta.title,
      description: meta.description,
      versions: [{version: manifest.version, publishTimestamp: timestamp,
        ...(manifest.engines?.dsh ? {engines: {dsh: manifest.engines.dsh}} : {}),
        source: {type: 'git', url: 'https://github.com/' + repo, commit, path: directory}}],
    })),
  };
}

export function shareLinks({repo, tag, commit}) {
  releaseOptions({repo, tag, commit});
  const [owner, name] = repo.split('/');
  const site = 'https://' + owner.toLowerCase() + '.github.io' +
    (name.toLowerCase() === owner.toLowerCase() + '.github.io' ? '' : '/' + name);
  return {index: site + '/index.json', release: 'https://github.com/' + repo + '/releases/tag/' + tag,
    download: 'https://github.com/' + repo + '/releases/download/' + tag + '/'};
}

export function makeShareText(records, options) {
  const links = shareLinks(options);
  const requirements = records.filter(record => record.manifest.engines?.dsh)
    .map(record => record.meta.title + ' 要求 DSH ' + record.manifest.engines.dsh).join('；');
  return '# DSH 插件安装与分享\n\n' +
    '## 推荐：插件发现页\n\n启用“自定义插件索引”，在“插件 → 发现 → 添加索引源”（已有源时选“管理索引源…”）中添加：\n\n' +
    '\x60\x60\x60text\n' + links.index + '\n\x60\x60\x60\n\n' +
    '添加后刷新索引，选择插件并确认安装。索引使用固定提交的 Git 子目录，不使用 Release 安装包。\n\n' +
    '## 直接安装单个插件\n\n在 DSH 的插件安装入口粘贴下方 URL，或把 URL 发给智能体并明确要求安装该插件；安装需要你确认。\n\n' +
    '| 插件 | 版本 | 安装包 URL |\n| --- | --- | --- |\n' +
    records.map(({meta, manifest, filename}) => '| ' + meta.title + ' | ' + manifest.version + ' | ' + links.download + filename + ' |').join('\n') +
    '\n\nGit 来源提交：' + options.commit + '\n\n' +
    '适配版本以各插件说明为准。' + (requirements ? requirements + '。' : '') +
    '安装不会复制作者的个人设置、MCP 配置或 OAuth 凭据。升级后按 DSH 提示重启/刷新；不强制覆盖同名插件。\n';
}

export function validatePack(manifest, pack) {
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  const names = new Set(pack.files.map(file => file.path));
  const required = ['package.json', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json'];
  for (const value of Object.values(manifest.exports)) {
    if (typeof value === 'string' && !value.includes('*')) required.push(value.replace(/^\.\//, ''));
  }
  for (const name of required) assert.ok(names.has(name), 'Missing packed resource: ' + name);
  for (const name of names) {
    assert.ok(!/(^|\/)(?:node_modules|test|tests|\.git|\.codex|\.env[^/]*)(\/|$)/.test(name), 'Unexpected private/test resource: ' + name);
    assert.ok(!/^(?:\/|\.\.\/)|(?:^|\/)\.\.(?:\/|$)/.test(name), 'Unsafe packed path: ' + name);
  }
}
