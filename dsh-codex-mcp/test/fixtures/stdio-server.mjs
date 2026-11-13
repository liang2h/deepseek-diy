// Local test-only JSON-RPC MCP server. Never invokes cloud CLIs or the network.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const longName = 'rocketmq-prod__RocketMQ-20220801-ListConsumerGroupSubscriptions';
const tools = ['echo', longName, 'slow', 'disconnect', 'rpc_error', 'is_error'].map((name) => ({
  name, description: `Local test tool ${name}`, inputSchema: { type: 'object', additionalProperties: true },
}));
const mode = process.env.TEST_MODE;
function record(message) {
  if (process.env.TEST_EVENT_LOG) appendFileSync(process.env.TEST_EVENT_LOG, `${JSON.stringify(message)}\n`);
}
function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
}
function snapshot(message) {
  return {
    name: message.params.name, arguments: message.params.arguments, pid: process.pid, cwd: process.cwd(),
    env: Object.fromEntries(['TEST_VALUE', 'TEST_SECRET', 'FAKE_SECRET', 'DSH_TEST_MARKER', 'EXPLICIT_CREDENTIAL'].map((key) => [key, process.env[key] ?? null])),
  };
}
record({ event: 'spawn', pid: process.pid });
// Deliberately emit fake sensitive package diagnostics: the connection must drain
// stderr rather than inherit it into the host's logs.
process.stderr.write('TEST_STDERR_FAKE_SECRET_DO_NOT_SURFACE\n');
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  record(message);
  switch (message.method) {
    case 'initialize':
      if (mode === 'startup-hang') return;
      result(message.id, {
        protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'local-test-fixture', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      if (mode === 'list-hang') return;
      result(message.id, { tools });
      return;
    case 'tools/call': {
      const name = message.params.name;
      if (name === 'slow') return;
      if (name === 'disconnect') return process.exit(0);
      if (name === 'rpc_error') {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'FAKE_REMOTE_SECRET_DO_NOT_SURFACE' } })}\n`);
        return;
      }
      if (name === 'is_error') {
        result(message.id, { isError: true, content: [{ type: 'text', text: 'FAKE_REMOTE_SECRET_DO_NOT_SURFACE' }] });
        return;
      }
      result(message.id, { content: [{ type: 'text', text: JSON.stringify(snapshot(message)) }] });
      return;
    }
    case 'ping': result(message.id, {}); return;
    default: return;
  }
});
input.on('close', () => process.exit(0));
