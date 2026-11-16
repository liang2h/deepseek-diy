// Always resolve the public npm fixture from this package, never a Desktop install.
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
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-registry',
];

// Check every reachable DSH dependency/peer, including the validator's peers.
// Matching versions alone is insufficient: Service and Context must share the
// same Cordis module identity. Optional absent peers do not belong to this graph.
export function assertRuntimeGraph() {
  const ownManifest = requireRuntime('./package.json');
  const fixtureModules = realpathSync(fileURLToPath(new URL('../node_modules/', import.meta.url))) + path.sep;
  const cordisPath = realpathSync(requireRuntime.resolve('@deepseek-ai/cordis'));
  const visited = new Map();
  const visit = (name, parentRequire) => {
    const manifestPath = realpathSync(parentRequire.resolve(name + '/package.json'));
    assert.ok(manifestPath.startsWith(fixtureModules), name + ' must resolve inside the package npm fixture');
    if (visited.has(manifestPath)) return;
    const manifest = parentRequire(manifestPath);
    assert.equal(manifest.version, name === '@deepseek-ai/cordis' ? CORDIS_VERSION : SDK_VERSION, name);
    const localRequire = createRequire(manifestPath);
    if (manifest.peerDependencies?.['@deepseek-ai/cordis']) {
      assert.equal(realpathSync(localRequire.resolve('@deepseek-ai/cordis')), cordisPath, name + ' must share Cordis');
    }
    visited.set(manifestPath, {name, version: manifest.version});
    for (const dependency of Object.keys({...manifest.dependencies, ...manifest.peerDependencies})) {
      if (!dependency.startsWith('@deepseek-ai/dsh-') && dependency !== '@deepseek-ai/cordis') continue;
      if (manifest.peerDependenciesMeta?.[dependency]?.optional) {
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
  for (const name of ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-typert-registry']) {
    assert.match(requireRuntime.resolve(name + '/client'), /[/\\]lib[/\\]client\.node\.js$/, name + ' must use the published Node client export');
  }
  return [...visited.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Importing a fixture fails fast on missing/mismatched packages; there is no skip
// or fallback to DSH_INSTALL_DIR, NODE_PATH, or a globally installed SDK.
export const runtimeGraph = assertRuntimeGraph();
