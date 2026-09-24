#!/usr/bin/env node
/**
 * End-to-end regression test for positional-argument dispatch.
 *
 * Stands up a fake OPNsense that echoes back the method, path and body it
 * received, spawns the built server against it over stdio, and asserts what
 * actually lands on the wire. This is the test that would have caught the
 * "[object Object]" bug: the old dispatcher produced a 200 response with an
 * empty body, so only inspecting the URL reveals the fault.
 *
 *   node test/dispatch.test.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'index.js');

// ---------------------------------------------------------------- fake OPNsense
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ _method: req.method, _path: req.url, _body: body ? JSON.parse(body) : null }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

// ---------------------------------------------------------------- MCP client
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    OPNSENSE_URL: `http://127.0.0.1:${port}`,
    OPNSENSE_API_KEY: 'test-key',
    OPNSENSE_API_SECRET: 'test-secret',
    OPNSENSE_VERIFY_SSL: 'false',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let nextId = 1;
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const timer = setTimeout(() => { console.error('TIMEOUT'); child.kill(); fake.close(); process.exit(1); }, 30000);

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'dispatch-test', version: '1' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r?.result?.content?.[0]?.text;
  if (!text) return { error: JSON.stringify(r?.error ?? r) };
  try { return JSON.parse(text).data ?? JSON.parse(text); } catch { return { raw: text }; }
};

// ---------------------------------------------------------------- cases
const UUID = 'e2d97026-06f8-48d8-808a-c75a1f337fbf';
const cases = [
  {
    name: 'uuid lands in the path, not [object Object]',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsGetPipe', params: { uuid: UUID } },
    check: (r) => r._path === `/api/trafficshaper/settings/get_pipe/${UUID}`,
  },
  {
    name: 'toggle gets both uuid and enabled',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsToggleRule', params: { uuid: UUID, enabled: '0' } },
    check: (r) => r._path === `/api/trafficshaper/settings/toggle_rule/${UUID}/0`,
  },
  {
    name: 'add sends the body at the top level of params',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsAddPipe', params: { pipe: { bandwidth: '150', scheduler: 'fq_codel' } } },
    check: (r) => r._method === 'POST' && r._body?.pipe?.bandwidth === '150',
  },
  {
    name: 'add also accepts the body nested under data, as the schema advertises',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsAddPipe', params: { data: { pipe: { bandwidth: '596' } } } },
    check: (r) => r._body?.pipe?.bandwidth === '596',
  },
  {
    name: 'set splits uuid from body',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsSetPipe', params: { uuid: UUID, pipe: { bandwidth: '140' } } },
    check: (r) => r._path === `/api/trafficshaper/settings/set_pipe/${UUID}` && r._body?.pipe?.bandwidth === '140',
  },
  {
    name: 'no-arg method sends no stray body',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsGet' },
    check: (r) => r._path === '/api/trafficshaper/settings/get' && !r._body,
  },
  {
    name: 'empty uuid is rejected instead of building a malformed URL',
    tool: 'trafficshaper_manage',
    args: { method: 'settingsGetPipe', params: { uuid: '' } },
    check: (r) => /cannot be an empty string/.test(JSON.stringify(r)),
  },
  {
    name: 'a different module also maps correctly',
    tool: 'firewall_manage',
    args: { method: 'filterGetRule', params: { uuid: UUID } },
    check: (r) => typeof r._path === 'string' && r._path.endsWith(UUID) && !r._path.includes('object'),
  },
];

let failed = 0;
for (const c of cases) {
  const r = await call(c.tool, c.args);
  let ok = false;
  try { ok = c.check(r); } catch { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) console.log(`        got: ${JSON.stringify(r).slice(0, 220)}`);
}

clearTimeout(timer);
child.kill();
fake.close();
console.log(failed === 0 ? `\nALL ${cases.length} PASS` : `\n${failed}/${cases.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);
