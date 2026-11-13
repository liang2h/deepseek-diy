import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {parseProjectConfig, configDigest} from './config.js';

export const trustKey = root => credentialKey('codex-mcp', `trust-${createHash('sha256').update(root).digest('hex')}`);
export const within = (root, candidate) => { const relative = path.relative(root, candidate); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

/** Reads exactly one project configuration, never ~/.codex or nested override layers. */
export async function readProject(ctx, agent, previousRoot, signal) {
  const cwd = ctx.workingDirectory.get(agent.session);
  const worlds = ctx.get('workspaceRegistry')?.list() || [];
  const owning = worlds.filter(workspace => within(workspace.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
  const chosen = owning?.path || (previousRoot && within(previousRoot, cwd) ? previousRoot : cwd);
  const rootTarget = await ctx.fs.resolve(chosen, {signal});
  const root = ctx.fs.processPath(rootTarget);
  // SDK-managed stdio and loopback callbacks run on this host, not an arbitrary remote execution world.
  if (ctx.fs.processPathFromHostPath(root) !== root) throw new Error('LOCAL_FILESYSTEM_REQUIRED');
  const target = await ctx.fs.resolve(path.join(root, '.codex', 'config.toml'), {signal});
  if (!ctx.fs.contains(rootTarget, target)) throw new Error('CONFIG_ESCAPES_PROJECT');
  const info = await ctx.fs.stat(target, signal);
  if (!info) return {root, target, digest: undefined, servers: []};
  if (info.type !== 'file' || info.size > 1024 * 1024) throw new Error('INVALID_CONFIG_FILE');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(await ctx.fs.readBytes(target, signal, 1024 * 1024));
  return {root, target, digest: configDigest(text), ...parseProjectConfig(text)};
}
const authorityOf = payload => typeof payload.activationId === 'string' ? payload.activationId :
  `legacy-${createHash('sha256').update(JSON.stringify([payload.digest, payload.trustedAt ?? null])).digest('hex')}`;
export async function trustAuthority(credentials, snapshot) {
  if (!snapshot.digest) return undefined;
  const record = await credentials.readRecord(trustKey(snapshot.root));
  const payload = record?.payload;
  if (record?.kind !== 'grant' || payload?.version !== 1 || payload.digest !== snapshot.digest || payload.revoked) return undefined;
  // Old grants remain trusted, but cannot match a pre-upgrade activation receipt.
  return authorityOf(payload);
}
export async function isTrusted(credentials, snapshot) { return (await trustAuthority(credentials, snapshot)) !== undefined; }
export async function saveTrust(credentials, snapshot, canCommit = () => true) {
  await credentials.modifyRecord(trustKey(snapshot.root), async () => canCommit() ? ({kind: 'grant', payload: {
    version: 1, digest: snapshot.digest, trustedAt: new Date().toISOString(), activationId: randomUUID(),
  }}) : undefined);
}
/** Observed configuration changes invalidate the old grant, not a newer human confirmation. */
export async function invalidateTrust(credentials, snapshot) {
  if (!snapshot?.digest) return;
  await credentials.modifyRecord(trustKey(snapshot.root), record =>
    record?.kind === 'grant' && record.payload?.digest === snapshot.digest ?
      {kind: 'grant', payload: {...record.payload, revoked: true, activationId: randomUUID()}} : undefined);
}
/** Logout keeps project trust but makes all old activation receipts obsolete. */
export async function rotateActivationAuthority(credentials, snapshot, authority) {
  await credentials.modifyRecord(trustKey(snapshot.root), record =>
    record?.kind === 'grant' && record.payload?.digest === snapshot.digest &&
      authorityOf(record.payload) === authority && !record.payload.revoked ?
      {kind: 'grant', payload: {...record.payload, activationId: randomUUID()}} : undefined);
}
