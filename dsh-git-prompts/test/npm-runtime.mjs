// Resolve public npm packages locally; never fall back to a Desktop SDK.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
export const SDK_VERSION = '0.2.2-rc.3';
export const CORDIS_VERSION = '4.1.0';
const runtimePackages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-tools',
];
const isSDK = name => name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis';

// Visit every reachable SDK dependency/peer, not only the direct fixture imports.
// Equal versions alone do not prove that Context and Service share module identity.
export function assertRuntimeGraph() {
  const ownManifest = requireRuntime('./package.json');
  const fixtureModules = realpathSync(fileURLToPath(new URL('../node_modules/', import.meta.url))) + path.sep;
  const cordisPath = realpathSync(requireRuntime.resolve('@deepseek-ai/cordis'));
  const cordis = requireRuntime('@deepseek-ai/cordis');
  const visited = new Map();
  const visit = (name, parentRequire) => {
    const manifestPath = realpathSync(parentRequire.resolve(name + '/package.json'));
    assert.ok(manifestPath.startsWith(fixtureModules), name + ' must resolve inside the package npm fixture');
    if (visited.has(manifestPath)) return;
    const manifest = parentRequire(manifestPath);
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, name === '@deepseek-ai/cordis' ? CORDIS_VERSION : SDK_VERSION, name);
    const localRequire = createRequire(manifestPath);
    const dependencies = {...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies};
    if (dependencies['@deepseek-ai/cordis']) {
      assert.equal(realpathSync(localRequire.resolve('@deepseek-ai/cordis')), cordisPath, name + ' must share Cordis path');
      assert.equal(localRequire('@deepseek-ai/cordis'), cordis, name + ' must share Cordis identity');
    }
    visited.set(manifestPath, {name, version: manifest.version});
    for (const dependency of Object.keys(dependencies).filter(isSDK)) {
      if (manifest.peerDependenciesMeta?.[dependency]?.optional || manifest.optionalDependencies?.[dependency]) {
        try { localRequire.resolve(dependency + '/package.json'); }
        catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
      }
      visit(dependency, localRequire);
    }
  };
  for (const name of runtimePackages) {
    assert.equal(ownManifest.devDependencies[name], name === '@deepseek-ai/cordis' ? CORDIS_VERSION : SDK_VERSION, name + ' must be pinned exactly');
    visit(name, requireRuntime);
  }
  const cordisInstances = [...visited.values()].filter(({name}) => name === '@deepseek-ai/cordis');
  assert.equal(cordisInstances.length, 1, 'Exactly one Cordis instance must be reachable');
  return [...visited.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Missing/mismatched npm dependencies are a hard failure, never a Desktop skip.
export const runtimeGraph = assertRuntimeGraph();
