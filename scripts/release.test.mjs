import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ROOT, releaseOptions, pluginRecords, makeIndex, shareLinks, makeShareText, validatePack, pnpm} from './release-lib.mjs';

const options = {repo: 'example/deepseek-diy', tag: 'plugins-v1.0.0', commit: 'a'.repeat(40)};
const records = await pluginRecords();

function gitAt(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8',
    env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}}).trim();
}

test('release parameters reject traversal, URLs, mutable refs and malformed tags', () => {
  assert.deepEqual(releaseOptions(options), options);
  for (const repo of ['../repo', 'owner/..', 'https://github.com/owner/repo', 'owner/repo/extra', 'owner/repo#main'])
    assert.throws(() => releaseOptions({...options, repo}));
  for (const commit of ['main', 'abc', 'A'.repeat(40), '0'.repeat(40)])
    assert.throws(() => releaseOptions({...options, commit}));
  for (const tag of ['v1.0.0', 'plugins-v1.0', 'plugins-v1.0.0/evil', '--help'])
    assert.throws(() => releaseOptions({...options, tag}));
});

test('format 1 index pins every real package and monorepo directory to a full commit', () => {
  const index = makeIndex(records, options, 1794555000);
  assert.equal(index.format, 1);
  assert.equal(records.length, 8);
  assert.ok(records.some(record => record.directory === 'dsh-auto-review-codex-compat'));
  assert.ok(records.some(record => record.directory === 'dsh-diagrams'));
  assert.ok(records.some(record => record.directory === 'dsh-next-input'));
  assert.ok(records.some(record => record.directory === 'dsh-git-prompts'));
  assert.equal(index.plugins.length, records.length);
  for (const [i, plugin] of index.plugins.entries()) {
    assert.equal(plugin.name, records[i].manifest.name);
    assert.equal(plugin.title, records[i].meta.title);
    const [version] = plugin.versions;
    assert.equal(version.version, records[i].manifest.version);
    assert.equal(version.publishTimestamp, 1794555000);
    assert.deepEqual(version.engines, records[i].manifest.engines?.dsh ? {dsh: records[i].manifest.engines.dsh} : undefined);
    assert.equal(plugin.description, records[i].meta.description);
    assert.deepEqual(version.source, {type: 'git', url: 'https://github.com/example/deepseek-diy',
      commit: options.commit, path: records[i].directory});
    assert.equal(plugin.spec, undefined);
  }
  assert.throws(() => makeIndex(records, options, Date.now()));
  assert.throws(() => makeIndex(records, options, 1.5));
});

test('index URL uses Pages rather than a redirecting GitHub release download', () => {
  assert.equal(shareLinks(options).index, 'https://example.github.io/deepseek-diy/index.json');
  assert.equal(shareLinks({...options, repo: 'Example/Example.github.io'}).index, 'https://example.github.io/index.json');
  assert.match(shareLinks(options).download, /\/releases\/download\/plugins-v1\.0\.0\/$/);
  const text = makeShareText(records, options);
  assert.ok(text.includes(shareLinks(options).index));
  assert.ok(text.includes('额外辅助模型费用'));
  assert.ok(text.includes('不自动发送或执行操作'));
  for (const record of records) {
    assert.ok(text.includes(shareLinks(options).download + record.filename));
    if (record.manifest.engines?.dsh)
      assert.ok(text.includes(record.meta.title + ' 要求 DSH ' + record.manifest.engines.dsh));
  }
});

test('packed resource validation rejects missing exports and private configuration', () => {
  const manifest = {name: '@local/example', version: '1.0.0', exports: {'.': './index.js'}};
  const files = ['package.json', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'index.js'];
  const pack = {name: manifest.name, version: manifest.version, files: files.map(path => ({path}))};
  validatePack(manifest, pack);
  assert.throws(() => validatePack(manifest, {...pack, files: pack.files.slice(0, -1)}));
  for (const path of ['.env', '.env.local', '.codex/config.toml', 'node_modules/a.js', 'test/fixture.js', '../private'])
    assert.throws(() => validatePack(manifest, {...pack, files: [...pack.files, {path}]}));
});

test('release CLI prepares an isolated tagged checkout and refuses overwrite or dirty source', async () => {
  const local = path.join(ROOT, '.local');
  await mkdir(local, {recursive: true});
  const directory = await mkdtemp(path.join(local, 'release-cli-test-'));
  try {
    for (const file of ['package.json', '.gitignore', 'scripts', ...records.map(record => record.directory)])
      await cp(path.join(ROOT, file), path.join(directory, file), {recursive: true,
        filter: source => !['node_modules', '.git', 'dist', '.local'].includes(path.basename(source))});
    gitAt(directory, ['init', '--initial-branch=main']);
    gitAt(directory, ['add', '.']);
    gitAt(directory, ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'Isolated release fixture']);
    const commit = gitAt(directory, ['rev-parse', 'HEAD']);
    gitAt(directory, ['tag', options.tag]);
    const args = ['scripts/prepare-release.mjs', '--repo', options.repo, '--tag', options.tag, '--commit', commit];
    const run = () => execFileSync(process.execPath, args, {cwd: directory, encoding: 'utf8', stdio: 'pipe'});
    run();
    const out = path.join(directory, 'dist/release');
    assert.equal((await readdir(out)).filter(file => file.endsWith('.tgz')).length, records.length);
    const indexText = await readFile(path.join(out, 'index.json'), 'utf8');
    assert.equal(await readFile(path.join(directory, 'dist/site/index.json'), 'utf8'), indexText);
    const index = JSON.parse(indexText);
    assert.ok(index.plugins.every(plugin => plugin.versions[0].source.commit === commit));
    const sums = (await readFile(path.join(out, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    assert.equal(sums.length, records.length + 2); // All packages, index and sharing instructions.
    assert.ok(sums.some(line => line.endsWith('  SHARE.md')));
    for (const line of sums) {
      const [expected, filename] = line.split('  ');
      assert.equal(createHash('sha256').update(await readFile(path.join(out, filename))).digest('hex'), expected);
    }
    assert.throws(run, /EEXIST/);
    assert.equal(await readFile(path.join(out, 'index.json'), 'utf8'), indexText);
    await writeFile(path.join(directory, 'uncommitted.txt'), 'not published');
    assert.throws(run, /commit all source changes/);
  } finally {
    assert.equal(path.dirname(directory), local);
    assert.ok(path.basename(directory).startsWith('release-cli-test-'));
    assert.equal(await realpath(directory), directory);
    await rm(directory, {recursive: true});
  }
});

for (const record of records) test('real tarball contains runtime exports, not local data: ' + record.directory, async () => {
  const local = path.join(ROOT, '.local');
  await mkdir(local, {recursive: true});
  const directory = await mkdtemp(path.join(local, 'release-test-'));
  try {
    const target = path.join(directory, record.filename);
    const pack = JSON.parse(pnpm(['pack', '--out', target, '--json'], {cwd: path.join(ROOT, record.directory), capture: true}));
    validatePack(record.manifest, pack);
    assert.ok((await readFile(target)).length > 0);
    const files = execFileSync('tar', ['-tzf', target], {encoding: 'utf8'}).trim().split('\n');
    assert.ok(files.every(file => file.startsWith('package/')));
    const actual = {name: pack.name, version: pack.version,
      files: files.filter(file => !file.endsWith('/')).map(file => ({path: file.slice('package/'.length)}))};
    validatePack(record.manifest, actual);
    const actualPaths = new Set(actual.files.map(file => file.path));
    if (record.directory === 'dsh-git-prompts') assert.ok(actualPaths.has('core.js'), 'Missing git-prompts core module');
    if (record.directory === 'dsh-next-input') {
      for (const name of ['core.js', 'suggestion-policy.js', 'diagnostics.js', 'version.js', 'client-state.js', 'remote-contract.js'])
        assert.ok(actualPaths.has(name), 'Missing next-input runtime module: ' + name);
    }
    assert.deepEqual(actualPaths, new Set(pack.files.map(file => file.path)));
  } finally {
    // Only remove this exact, unique test-owned directory. Never accept a CLI cleanup path.
    assert.equal(path.dirname(directory), local);
    assert.ok(path.basename(directory).startsWith('release-test-'));
    assert.equal(await realpath(directory), directory);
    await rm(directory, {recursive: true});
  }
});
