import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {ROOT, releaseOptions, pluginRecords, makeIndex, makeShareText, shareLinks, pnpm, validatePack} from './release-lib.mjs';

const {values} = parseArgs({options: {repo: {type: 'string'}, tag: {type: 'string'}, commit: {type: 'string'}}});
const options = releaseOptions({repo: values.repo || process.env.GITHUB_REPOSITORY,
  tag: values.tag || process.env.GITHUB_REF_NAME, commit: values.commit || process.env.GITHUB_SHA});
const git = args => execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
assert.equal(git(['rev-parse', 'HEAD']), options.commit, 'publish the checked-out commit, not a different revision');
assert.equal(git(['rev-parse', options.tag + '^{commit}']), options.commit, 'tag must point to the checked-out commit');
assert.equal(git(['status', '--porcelain']), '', 'commit all source changes (including the built client) before preparing a release');
const records = await pluginRecords();
// Preview before packing: never upload configuration, test fixtures or missing exports.
for (const {directory, manifest} of records) {
  validatePack(manifest, JSON.parse(pnpm(['pack', '--dry-run', '--json'], {cwd: path.join(ROOT, directory), capture: true})));
}
const out = path.join(ROOT, 'dist/release');
await mkdir(path.dirname(out), {recursive: true});
// No overwrite or recursive deletion: an existing release directory requires a deliberate new run setup.
await mkdir(out);
const checksums = [];
for (const {directory, manifest, filename} of records) {
  const target = path.join(out, filename);
  const packed = JSON.parse(pnpm(['pack', '--out', target, '--json'], {cwd: path.join(ROOT, directory), capture: true}));
  validatePack(manifest, packed);
  checksums.push(createHash('sha256').update(await readFile(target)).digest('hex') + '  ' + filename);
}
// A tag-derived timestamp keeps artifacts reproducible when a failed deployment is retried.
const timestamp = Number(git(['for-each-ref', '--format=%(creatordate:unix)', 'refs/tags/' + options.tag]));
const index = JSON.stringify(makeIndex(records, options, timestamp), null, 2) + '\n';
await writeFile(path.join(out, 'index.json'), index, {flag: 'wx'});
checksums.push(createHash('sha256').update(index).digest('hex') + '  index.json');
const share = makeShareText(records, options);
await writeFile(path.join(out, 'SHARE.md'), share, {flag: 'wx'});
checksums.push(createHash('sha256').update(share).digest('hex') + '  SHARE.md');
await writeFile(path.join(out, 'SHA256SUMS'), checksums.join('\n') + '\n', {flag: 'wx'});
const site = path.join(ROOT, 'dist/site');
await mkdir(site);
await writeFile(path.join(site, 'index.json'), index, {flag: 'wx'});
const links = shareLinks(options);
await writeFile(path.join(site, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<title>DeepSeek DIY 插件</title><h1>DeepSeek DIY 插件</h1><p>在 DSH 的插件发现页添加此索引：</p>' +
  '<p><a href="' + links.index + '">' + links.index + '</a></p><p><a href="' + links.release +
  '">下载插件、安装步骤和校验值</a></p></html>\n', {flag: 'wx'});
console.log('Prepared local release: ' + out + '\nIndex URL after GitHub Pages deployment: ' + links.index);
