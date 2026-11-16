import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {ROOT, PLUGINS} from './release-lib.mjs';

for (const directory of PLUGINS) {
  const cwd = path.join(ROOT, directory);
  console.log('\n=== ' + directory + ' ===');
  for (const file of await readdir(cwd)) {
    if (/\.(?:js|mjs)$/.test(file)) execFileSync(process.execPath, ['--check', file], {cwd, stdio: 'inherit'});
  }
  const tests = (await readdir(path.join(cwd, 'test'))).filter(file => file.endsWith('.test.js'));
  const env = {...process.env};
  if (directory === 'dsh-next-input') {
    // Its locked npm contract fixture must work without an ambient Desktop installation.
    delete env.DSH_NODE_EXECUTABLE;
    delete env.DSH_INSTALL_DIR;
  }
  execFileSync(process.execPath, ['--test', ...tests.map(file => 'test/' + file)], {cwd, env, stdio: 'inherit'});
}
