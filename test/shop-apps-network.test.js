import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createStudio } from '../src/studio.js';

function setup(t, resolve) {
  const state = { dnsCalls: 0, connections: [], fetches: 0 };
  t.mock.method(globalThis, 'fetch', async () => { state.fetches++; return new Response('<html>unsafe fallback</html>'); });
  t.mock.method(dns, 'lookup', (host, options, callback) => { state.dnsCalls++; assert.equal(host, 'shop.example'); callback(null, resolve()); });
  t.mock.method(https, 'request', (url, options, response) => {
    assert.equal(url.href, 'https://shop.example/');
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    assert.notEqual(options.rejectUnauthorized, false); state.requestHeaders = options.headers;
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => options.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) { req.emit('error', error); return; }
      state.connections.push(addresses);
      const res = Readable.from([Buffer.from('<html><script src="https://third.example/app.js"></script></html>')]);
      res.statusCode = 200; res.headers = { 'content-type': 'text/html', ...(state.encoding ? { 'content-encoding': state.encoding } : {}) }; response(res);
    }));
    return req;
  });
  const studio = createStudio(':memory:', { shopConnector: null, env: { ARCHIPEL_ALLOW_REAL_NETWORK: '1', WORKEDA_SHOP_DOMAIN: 'shop.example' } });
  t.after(() => studio.close());
  studio.integrations.setDetectionEnabled(true);
  return { svc: studio.integrations, state };
}

test('public detection rejects nonpublic DNS answers before a connection, including mixed and mapped addresses', async (t) => {
  let records;
  const { svc, state } = setup(t, () => records);
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:a00:1::1', '3fff::1']) {
    records = [{ address, family: address.includes(':') ? 6 : 4 }];
    const scan = await svc.runDetection({ confirm: true });
    assert.equal(scan.page.ok, false, address);
  }
  records = [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }];
  assert.equal((await svc.runDetection({ confirm: true })).page.ok, false);
  records = [];
  assert.equal((await svc.runDetection({ confirm: true })).page.ok, false);
  assert.equal(state.connections.length, 0); assert.equal(state.fetches, 0);
});

test('public detection pins the validated DNS result for its HTTPS connection and rechecks each scan', async (t) => {
  const publicRecords = [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  let records = publicRecords;
  const { svc, state } = setup(t, () => records);
  const scan = await svc.runDetection({ confirm: true });
  assert.equal(scan.page.ok, true); assert.ok(scan.page.bytes > 0);
  assert.equal(scan.findings.length, 1); assert.equal(scan.findings[0].bytes, null);
  assert.deepEqual(state.connections, [publicRecords]); assert.equal(state.dnsCalls, 1); assert.equal(state.fetches, 0);
  records = [{ address: '127.0.0.1', family: 4 }];
  assert.equal((await svc.runDetection({ confirm: true })).page.ok, false);
  assert.equal(state.connections.length, 1); assert.equal(state.dnsCalls, 2);
});

test('encoded responses are refused instead of reporting a successful empty detection', async (t) => {
  const { svc, state } = setup(t, () => [{ address: '1.1.1.1', family: 4 }]);
  for (const encoding of ['gzip', 'br']) {
    state.encoding = encoding;
    const scan = await svc.runDetection({ confirm: true });
    assert.equal(scan.page.ok, false, encoding);
    assert.equal(state.requestHeaders['accept-encoding'], 'identity');
  }
});
