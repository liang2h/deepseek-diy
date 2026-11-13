// Tests the real Cordis dependency guard in an isolated native Context.
// No React, DOM, simulated page, new server, user Session or profile writes.
import {connect} from './cdp.mjs';

async function verifyNativeGuard() {
  const Context = this.constructor;
  const Service = Object.getPrototypeOf(this.get('typert').constructor);
  if (Context.name !== 'Context' || Service.name !== 'Service') throw new Error('Unexpected native constructors');
  const isolated = new Context();
  const tag = Symbol('scope-fixture');
  let scope;
  try {
    await isolated.plugin({name: 'side-chat-test-base', apply(ctx) {new Service(ctx, 'remote');}});
    await isolated.plugin({name: 'side-chat-test-scope', inject: ['remote'], apply(ctx) {scope = ctx.extend({[tag]: 'session-native-fixture'});}});
    const missingBefore = scope.get('remote.localSideChat') === undefined;
    const namespace = isolated.plugin({name: 'side-chat-test-namespace', apply(ctx) {
      class Probe extends Service {
        constructor(ctx) {super(ctx, 'remote.localSideChat');}
        describeCaller() {return {tag: this.ctx[tag], sameFiber: this.ctx.fiber === scope.fiber};}
        // Matches the native RemoteNamespaceService method's caller-context closure.
        get projectedMethod() {const caller = this.ctx; return () => ({tag: caller[tag], sameFiber: caller.fiber === scope.fiber});}
      }
      new Probe(ctx);
    }});
    await namespace;
    let oldError;
    try {void scope.remote.localSideChat;} catch (failure) {oldError = failure.message;}
    const api = scope.get('remote.localSideChat');
    const result = {missingBefore, oldError, tracedServiceContextExactlyScope: api.ctx === scope,
      methodCaller: api.describeCaller(), getterClosedCaller: api.projectedMethod()};
    if (!missingBefore || oldError !== 'cannot get property "remote.localSideChat" without inject' ||
      !result.tracedServiceContextExactlyScope || result.methodCaller.tag !== 'session-native-fixture' || !result.methodCaller.sameFiber ||
      result.getterClosedCaller.tag !== 'session-native-fixture' || !result.getterClosedCaller.sameFiber) throw new Error(JSON.stringify(result));
    await namespace.dispose();
    result.missingAfterNamespaceDispose = scope.get('remote.localSideChat') === undefined;
    if (!result.missingAfterNamespaceDispose) throw new Error('Namespace still active after disposal');
    return result;
  } finally {await isolated.fiber.dispose();}
}

const cdp = await connect();
try {
  const {root} = await cdp.call('DOM.getDocument', {depth: 3});
  const {object} = await cdp.call('DOM.resolveNode', {nodeId: root.children[0].children[0].nodeId});
  const outcome = await cdp.call('Runtime.callFunctionOn', {objectId: object.objectId,
    functionDeclaration: verifyNativeGuard.toString(), awaitPromise: true, returnByValue: true});
  if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
  console.log(JSON.stringify(outcome.result.value, null, 2));
} finally {cdp.close();}
