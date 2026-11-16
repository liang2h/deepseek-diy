import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const result = await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['client.js'], outfile: 'client.bundle.js',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof', metafile: true,
  banner: {js: '/* DSH Diagrams — generated; Mermaid and dependencies: see THIRD_PARTY_NOTICES.md. */'},
});

// Ship the exact license texts of every package represented in the browser bundle.
const packages = new Map();
const visited = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory.includes('node_modules')) {
    if (visited.has(directory)) break;
    visited.add(directory);
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name && manifest.version) { packages.set(manifest.name + '@' + manifest.version, {directory, manifest}); break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = dirname(directory);
  }
}
const notices = ['# Third-party notices', '', 'Generated from the bundled runtime dependencies. Upstream licenses apply only to their respective components.', '',
  '## ELK source code availability', '',
  'The bundled elkjs 0.12.1 and ELK 0.12.1 source code is available under the Eclipse Public License 2.0; upstream also offers the stated GPL alternative. No local patches were applied to these upstream packages before bundling.', '',
  '- elkjs JavaScript/adapter sources and build scripts: https://github.com/kieler/elkjs/tree/624ae90aa37110033a8af59c5ccbb292708b4317 (tag 0.12.1).',
  '- ELK Java/algorithm sources: https://github.com/eclipse-elk/elk/tree/3aa3b9fb98d8f9a41285b3061cff5efe79ed2ba4 (tag v0.12.1).',
  '- Source archives are available from each repository tag and its Code / Download ZIP action. Version mapping: https://github.com/kieler/elkjs/releases/tag/0.12.1.',
  '- The surrounding plugin sources and bundling instructions are in the dsh-diagrams directory of this repository.', '',
];
for (const [name, {directory, manifest}] of [...packages].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  notices.push('## ' + name, '', 'License: ' + (typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? 'See upstream license')), '');
  const files = (await readdir(directory)).filter(file => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file)).sort();
  if (!files.length) throw Error('Missing license text for bundled package ' + name);
  for (const file of files) notices.push('### ' + file, '', '```text', (await readFile(join(directory, file), 'utf8')).trim(), '```', '');
}
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
console.log('Built diagram client with ' + packages.size + ' dependency notices.');
